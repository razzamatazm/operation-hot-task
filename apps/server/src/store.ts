import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Loan, LoanTask, SYSTEM_ACTOR, TaskHistoryEvent, TaskStatus, hasCorrectionsState } from "@loan-tasks/shared";

/* The limits past which the start-up migration below refuses to act (#236:
   "more than a handful, or they cluster on one task type"). A handful is five;
   a cluster is more than two of one type. */
const STRANDED_HANDFUL = 5;
const STRANDED_CLUSTER_LIMIT = 2;

interface DataShape {
  tasks: LoanTask[];
  history: TaskHistoryEvent[];
}

const INITIAL: DataShape = {
  tasks: [],
  history: []
};

export class TaskStore {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(INITIAL, null, 2), "utf8");
    }

    await this.migrateStrandedCorrections();
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
    await this.enqueue(async () => {
      const data = await this.read();
      const stranded = data.tasks.filter((task) => task.status === "NEEDS_REVIEW" && !hasCorrectionsState(task));
      if (stranded.length === 0) {
        return;
      }
      const byType = stranded.reduce<Record<string, number>>((acc, task) => ({ ...acc, [task.taskType]: (acc[task.taskType] ?? 0) + 1 }), {});
      const clustered = Object.values(byType).some((count) => count > STRANDED_CLUSTER_LIMIT);
      if (stranded.length > STRANDED_HANDFUL || clustered) {
        console.error(
          `[store] ${stranded.length} non-LOI task(s) are in NEEDS_REVIEW (${JSON.stringify(byType)}). ` +
            `That is more than a handful or clustered on one type, so they were NOT migrated — ` +
            `raise it on #236 / ADR-0007 before deciding what to do with them.`
        );
        return;
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
      await this.write(data);
      console.warn(`[store] moved ${stranded.length} non-LOI task(s) out of NEEDS_REVIEW at start-up (ADR-0007): ${JSON.stringify(byType)}`);
    });
  }

  private async read(): Promise<DataShape> {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DataShape>;
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => this.normalizeTask(task)) : [];
    return {
      tasks,
      history: parsed.history ?? []
    };
  }

  private async write(data: DataShape): Promise<void> {
    const normalized: DataShape = {
      tasks: data.tasks.map((task) => this.normalizeTask(task)),
      history: data.history
    };
    await fs.writeFile(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
  }

  async allTasks(): Promise<LoanTask[]> {
    const data = await this.read();
    return data.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async allHistoryForTask(taskId: string): Promise<TaskHistoryEvent[]> {
    const data = await this.read();
    return data.history.filter((event) => event.taskId === taskId).sort((a, b) => a.at.localeCompare(b.at));
  }

  async findTask(taskId: string): Promise<LoanTask | undefined> {
    const data = await this.read();
    return data.tasks.find((task) => task.id === taskId);
  }

  /* Read-modify-write in one queue slot. `apply` gets the task as it is RIGHT
     NOW — read inside the same slot that writes the result — so nothing can
     land in between and be overwritten.

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
    return this.enqueue(async () => {
      const data = await this.read();
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
      await this.write(data);
      return result.task;
    });
  }

  /* Whole-task replacement. Correct for a task that did not exist a moment ago
     (creation); for anything that reads-then-changes, use `updateTask` above so
     the read and the write can't be split by a concurrent writer. */
  async upsertTask(task: LoanTask, event?: TaskHistoryEvent): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.read();
      const index = data.tasks.findIndex((entry) => entry.id === task.id);
      if (index >= 0) {
        data.tasks[index] = task;
      } else {
        data.tasks.push(task);
      }
      if (event) {
        data.history.push(event);
      }
      await this.write(data);
    });
  }

  async appendHistory(event: TaskHistoryEvent): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.read();
      data.history.push(event);
      await this.write(data);
    });
  }

  async replaceTasks(tasks: LoanTask[], event?: TaskHistoryEvent): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.read();
      data.tasks = tasks;
      if (event) {
        data.history.push(event);
      }
      await this.write(data);
    });
  }

  async removeTasks(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.enqueue(async () => {
      const data = await this.read();
      const idSet = new Set(ids);
      data.tasks = data.tasks.filter((task) => !idSet.has(task.id));
      await this.write(data);
    });
  }

  /* One writer at a time, in call order. The chain itself is kept settled and
     value-free: the caller gets this operation's result (or its rejection),
     while the next operation runs either way — one caller's failure must not
     wedge every write behind it. */
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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

const LOAN_INITIAL: LoanDataShape = { loans: [] };

/* File-backed store for the Loan entity (ADR-0001), mirroring TaskStore's
   read-modify-write-through-a-chain pattern ahead of the eventual Azure SQL
   migration. */
export class LoanStore {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(LOAN_INITIAL, null, 2), "utf8");
    }
  }

  private async read(): Promise<LoanDataShape> {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LoanDataShape>;
    return { loans: Array.isArray(parsed.loans) ? parsed.loans : [] };
  }

  private async write(data: LoanDataShape): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async all(): Promise<Loan[]> {
    const data = await this.read();
    return data.loans;
  }

  async find(loanId: string): Promise<Loan | undefined> {
    const data = await this.read();
    return data.loans.find((loan) => loan.id === loanId);
  }

  async upsert(loan: Loan): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.read();
      const index = data.loans.findIndex((entry) => entry.id === loan.id);
      if (index >= 0) {
        data.loans[index] = loan;
      } else {
        data.loans.push(loan);
      }
      await this.write(data);
    });
  }

  async replaceAll(loans: Loan[]): Promise<void> {
    await this.enqueue(async () => {
      await this.write({ loans });
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}
