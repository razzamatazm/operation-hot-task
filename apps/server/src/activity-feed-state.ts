import { promises as fs } from "node:fs";
import path from "node:path";
import { UserIdentity } from "@loan-tasks/shared";

export type ActivitySignalType = "CLAIMABLE" | "OVERDUE" | "NEEDS_REVIEW";

export interface ActivitySignalState {
  key: string;
  userId: string;
  taskId: string;
  signalType: ActivitySignalType;
  isActive: boolean;
  lastActivatedAt: string;
  lastNotifiedAt: string;
  lastReminderAt?: string;
}

export interface KnownUserState {
  id: string;
  displayName: string;
  roles: UserIdentity["roles"];
}

interface ActivityFeedStateData {
  signals: ActivitySignalState[];
  users: KnownUserState[];
}

const INITIAL: ActivityFeedStateData = {
  signals: [],
  users: []
};

export class ActivityFeedStateStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, JSON.stringify(INITIAL, null, 2), "utf8");
    }
  }

  async read(): Promise<ActivityFeedStateData> {
    const raw = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ActivityFeedStateData>;
    return {
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      users: Array.isArray(parsed.users) ? parsed.users : []
    };
  }

  async upsertUser(user: UserIdentity): Promise<void> {
    await this.enqueue(async () => {
      const state = await this.read();
      const index = state.users.findIndex((entry) => entry.id === user.id);
      const next: KnownUserState = {
        id: user.id,
        displayName: user.displayName,
        roles: user.roles
      };
      if (index >= 0) {
        state.users[index] = next;
      } else {
        state.users.push(next);
      }
      await this.write(state);
    });
  }

  async replace(state: ActivityFeedStateData): Promise<void> {
    await this.enqueue(async () => {
      await this.write(state);
    });
  }

  private async write(state: ActivityFeedStateData): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}
