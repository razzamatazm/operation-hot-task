import { promises as fs } from "node:fs";
import path from "node:path";
import { Loan, LoanTask, TaskHistoryEvent } from "@loan-tasks/shared";

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
     Throwing from `apply` writes nothing and rejects only that caller. */
  async updateTask(
    taskId: string,
    apply: (current: LoanTask) => { task: LoanTask; event?: TaskHistoryEvent } | undefined
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
        data.history.push(result.event);
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
