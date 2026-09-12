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

export interface ActivityFeedStateData {
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

  /* Work out the next state from the file as it stands at this change's turn,
     and save it, in one step (#341). `decide` gets a fresh copy of the state and
     returns the state to save plus whatever it decided; that decision is what
     this resolves with, once the save is done. `decide` must be synchronous:
     anything awaited inside it would let another change in between. A whole-file
     `replace` built from an earlier read used to overwrite users recorded in the
     meantime and let overlapping evaluations alert the same signal twice. */
  async change<R>(
    decide: (current: ActivityFeedStateData) => { state: ActivityFeedStateData; decision: R }
  ): Promise<R> {
    let decision: R | undefined;
    await this.file.update((current) => {
      const next = decide(current);
      decision = next.decision;
      return next.state;
    });
    return decision as R;
  }
}
