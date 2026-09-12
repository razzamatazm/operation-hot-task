import { randomUUID } from "node:crypto";
import { Loan, LoanTask, SYSTEM_ACTOR, TaskHistoryEvent, TaskStatus, hasCorrectionsState, migrateTaskMessages } from "@loan-tasks/shared";
import { JsonFile } from "./json-file.js";

/* The limits past which the start-up migration below refuses to act (#236:
   "more than a handful, or they cluster on one task type"). A handful is five;
   a cluster is more than two of one type. */
const STRANDED_HANDFUL = 5;
const STRANDED_CLUSTER_LIMIT = 2;

interface DataShape {
  tasks: LoanTask[];
  history: TaskHistoryEvent[];
}

/* Tasks and their history, in one file. Every read and change goes through
   `JsonFile`, which is what keeps a read from landing mid-save (#331). */
export class TaskStore {
  private readonly file: JsonFile<DataShape>;

  constructor(filePath: string) {
    this.file = new JsonFile<DataShape>(filePath, {
      empty: () => ({ tasks: [], history: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<DataShape>;
        return {
          tasks: Array.isArray(raw.tasks) ? raw.tasks.map((task) => this.normalizeTask(task)) : [],
          history: raw.history ?? []
        };
      },
      encode: (data) => ({
        tasks: data.tasks.map((task) => this.normalizeTask(task)),
        history: data.history
      })
    });
  }

  async init(): Promise<void> {
    await this.file.init();
    await this.migrateStrandedCorrections();
    await this.migrateMessageIdentity();
  }

  /* #286 / ADR-0009: every stored message gains a stable identifier and, where
     the app wrote its prefix into the text, a label held apart from the
     author's words. Messages written from now on carry both from birth; the
     ones already in the file have neither, and nothing else will ever give
     them one.

     Nothing a person can see changes — `noteBodyText` puts a label back in
     front of its text exactly as `needsFixesNote` once stored it — so this
     writes no history rows and touches no `updatedAt`. It is a change to the
     shape of the record, not an act on the task, and ADR-0009 rule 6 is
     explicit that a correction must not drag an old task up the done list.

     Safe to run twice, and it runs at every start-up. The rule for what needs
     repairing lives in `migrateTaskMessages` in the shared package, which
     repairs only what is missing and reports whether it moved anything; the
     second pass finds nothing, reports no change, and this writes nothing. */
  private async migrateMessageIdentity(): Promise<void> {
    let touched = 0;
    await this.file.update((data) => {
      const tasks = data.tasks.map((task) => {
        const result = migrateTaskMessages(task, () => randomUUID());
        if (result.changed) touched += 1;
        return result.task;
      });
      return touched === 0 ? undefined : { ...data, tasks };
    });
    if (touched > 0) {
      console.warn(`[store] gave stored messages an identifier and a label on ${touched} task(s) (#286, ADR-0009)`);
    }
  }

  /* NEEDS_REVIEW became LOI-only (ADR-0007, #236). Any task of another type
     still sitting in it at start-up would otherwise be stranded on a status its
     type can no longer hold — no surface offers a way out and the server would
     refuse one. Each is put back where the rule would have left it: with its
     holder (CLAIMED) if someone still has it, otherwise in the pool (OPEN). One
     history row per task, attributed to the system, so the move is on the
     record. Runs once per start-up and finds nothing on the second pass.

     Unless there are a lot of them. #236 says a population that is more than a
     handful, or that clusters on one task type, means the state was in real
     use somewhere the decision did not know about, and is a reason to stop
     and re-open the question rather than migrate harder. So past either limit
     nothing is touched: the tasks stay where they are, still visible, and the
     start-up log says so loudly. Somebody then decides. */
  private async migrateStrandedCorrections(): Promise<void> {
    let moved: { count: number; byType: Record<string, number> } | undefined;
    await this.file.update((data) => {
      const stranded = data.tasks.filter((task) => task.status === "NEEDS_REVIEW" && !hasCorrectionsState(task));
      if (stranded.length === 0) {
        return undefined;
      }
      const byType = stranded.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.taskType]: (acc[task.taskType] ?? 0) + 1 }), {});
      const clustered = Object.values(byType).some((count) => count > STRANDED_CLUSTER_LIMIT);
      if (stranded.length > STRANDED_HANDFUL || clustered) {
        console.error(
          `[store] ${stranded.length} non-LOI task(s) are in NEEDS_REVIEW (${JSON.stringify(byType)}). ` +
            `That is more than a handful or clustered on one type, so they were NOT migrated — ` +
            `raise it on #236 / ADR-0007 before deciding what to do with them.`
        );
        return undefined;
      }
      const now = new Date().toISOString();
      for (const task of stranded) {
        const status: TaskStatus = task.assignee ? "CLAIMED" : "OPEN";
        task.status = status;
        task.updatedAt = now;
        data.history.push({
          id: randomUUID(),
          taskId: task.id,
          action: "TASK_STATUS_CHANGED",
          at: now,
          by: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
          detail: `Moved from NEEDS_REVIEW to ${status}: only an LOI Check can be in needs corrections (ADR-0007)`
        });
      }
      moved = { count: stranded.length, byType };
      return data;
    });
    if (moved) {
      console.warn(`[store] moved ${moved.count} non-LOI task(s) out of NEEDS_REVIEW at start-up (ADR-0007): ${JSON.stringify(moved.byType)}`);
    }
  }

  /* Copy tasks.json into `dir` as it stands, before a migration rewrites it (#370). */
  async backupInto(dir: string): Promise<void> {
    await this.file.copyInto(dir);
  }

  async allTasks(): Promise<LoanTask[]> {
    const data = await this.file.read();
    return data.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async allHistoryForTask(taskId: string): Promise<TaskHistoryEvent[]> {
    const data = await this.file.read();
    return data.history.filter((event) => event.taskId === taskId).sort((a, b) => a.at.localeCompare(b.at));
  }

  async findTask(taskId: string): Promise<LoanTask | undefined> {
    const data = await this.file.read();
    return data.tasks.find((task) => task.id === taskId);
  }

  /* Read-modify-write in one step. `apply` gets the task as it is RIGHT NOW —
     read in the same step that writes the result — so nothing can land in
     between and be overwritten.

     This exists because `upsertTask` below takes a finished task, and a caller
     necessarily built that task from a read it did earlier. Two callers reading
     the same starting state each write a full replacement, and the second one
     silently erases the first: serializing the WRITES never helped, because the
     damage was done at the READ (#158).

     Returns the written task, or `undefined` when `apply` declines — the task
     was deleted while we queued, or the operation turned out to be a no-op.
     Throwing from `apply` writes nothing and rejects only that caller.

     `event` takes a list as well as a single row, for the one move that writes
     more than one: the confirm at the tail of the corrections loop both
     completes and archives, and the history is not allowed to lose a step
     because the user only pressed once (#238). Passing them here rather than
     following the write with `appendHistory` is the point — the task and every
     row it earned land in the same `write`, so nothing can leave the task
     archived with only half its record, or the reverse. */
  async updateTask(
    taskId: string,
    apply: (current: LoanTask) => { task: LoanTask; event?: TaskHistoryEvent | TaskHistoryEvent[] } | undefined
  ): Promise<LoanTask | undefined> {
    let written: LoanTask | undefined;
    await this.file.update((data) => {
      const index = data.tasks.findIndex((entry) => entry.id === taskId);
      if (index < 0) {
        return undefined;
      }
      const result = apply(data.tasks[index] as LoanTask);
      if (!result) {
        return undefined;
      }
      data.tasks[index] = result.task;
      if (result.event) {
        data.history.push(...(Array.isArray(result.event) ? result.event : [result.event]));
      }
      written = result.task;
      return data;
    });
    return written;
  }

  /* Whole-task replacement. Correct for a task that did not exist a moment ago
     (creation); for anything that reads-then-changes, use `updateTask` above so
     the read and the write can't be split by a concurrent writer. */
  async upsertTask(task: LoanTask, event?: TaskHistoryEvent): Promise<void> {
    await this.file.update((data) => {
      const index = data.tasks.findIndex((entry) => entry.id === task.id);
      if (index >= 0) {
        data.tasks[index] = task;
      } else {
        data.tasks.push(task);
      }
      if (event) {
        data.history.push(event);
      }
      return data;
    });
  }

  async appendHistory(event: TaskHistoryEvent): Promise<void> {
    await this.file.update((data) => {
      data.history.push(event);
      return data;
    });
  }

  async replaceTasks(tasks: LoanTask[], event?: TaskHistoryEvent): Promise<void> {
    await this.file.update((data) => {
      data.tasks = tasks;
      if (event) {
        data.history.push(event);
      }
      return data;
    });
  }

  async removeTasks(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const idSet = new Set(ids);
    await this.file.update((data) => {
      data.tasks = data.tasks.filter((task) => !idSet.has(task.id));
      return data;
    });
  }

  private normalizeTask(task: LoanTask): LoanTask {
    const raw = task as LoanTask & { folderName?: string; loanName?: string; serverLocation?: string; points?: number };
    const folderName = raw.folderName?.trim() || raw.loanName?.trim() || raw.serverLocation?.trim() || "Untitled Task";
    const points = Number.isInteger(raw.points) && (raw.points ?? 0) >= 1 && (raw.points ?? 0) <= 5 ? (raw.points as number) : 1;
    return {
      ...raw,
      folderName,
      loanName: folderName,
      points
    };
  }
}

interface LoanDataShape {
  loans: Loan[];
}

/* File-backed store for the Loan entity (ADR-0001), built on the same
   `JsonFile` as TaskStore ahead of the eventual Azure SQL migration. */
export class LoanStore {
  private readonly file: JsonFile<LoanDataShape>;

  constructor(filePath: string) {
    this.file = new JsonFile<LoanDataShape>(filePath, {
      empty: () => ({ loans: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<LoanDataShape>;
        return { loans: Array.isArray(raw.loans) ? raw.loans : [] };
      }
    });
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  /* Copy loans.json into `dir` as it stands, before a migration rewrites it (#370). */
  async backupInto(dir: string): Promise<void> {
    await this.file.copyInto(dir);
  }

  async all(): Promise<Loan[]> {
    const data = await this.file.read();
    return data.loans;
  }

  async find(loanId: string): Promise<Loan | undefined> {
    const data = await this.file.read();
    return data.loans.find((loan) => loan.id === loanId);
  }

  async upsert(loan: Loan): Promise<void> {
    await this.file.update((data) => {
      const index = data.loans.findIndex((entry) => entry.id === loan.id);
      if (index >= 0) {
        data.loans[index] = loan;
      } else {
        data.loans.push(loan);
      }
      return data;
    });
  }

  async replaceAll(loans: Loan[]): Promise<void> {
    await this.file.update(() => ({ loans }));
  }
}
