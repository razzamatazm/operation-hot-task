import { promises as fs } from "node:fs";
import path from "node:path";
import { LoanTask, TaskHistoryEvent } from "@loan-tasks/shared";

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
    const parsed = JSON.parse(raw) as DataShape;
    return {
      tasks: parsed.tasks ?? [],
      history: parsed.history ?? []
    };
  }

  private async write(data: DataShape): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
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

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}
