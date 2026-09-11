import { UserIdentity } from "@loan-tasks/shared";
import { JsonFile } from "./json-file.js";

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

/* Built on `JsonFile`, so a read waits behind a save; before that, a read
   landing mid-save threw and dropped that pass of signal evaluation (#339). */
export class ActivityFeedStateStore {
  private readonly file: JsonFile<ActivityFeedStateData>;

  constructor(filePath: string) {
    this.file = new JsonFile<ActivityFeedStateData>(filePath, {
      empty: () => ({ signals: [], users: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<ActivityFeedStateData>;
        return {
          signals: Array.isArray(raw.signals) ? raw.signals : [],
          users: Array.isArray(raw.users) ? raw.users : []
        };
      }
    });
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  read(): Promise<ActivityFeedStateData> {
    return this.file.read();
  }

  async upsertUser(user: UserIdentity): Promise<void> {
    await this.file.update((state) => {
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
      return state;
    });
  }

  async replace(state: ActivityFeedStateData): Promise<void> {
    await this.file.update(() => state);
  }
}
