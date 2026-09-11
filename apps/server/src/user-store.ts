import { UserIdentity, UserRole } from "@loan-tasks/shared";
import { AuthIdentity } from "./auth.js";
import { JsonFile } from "./json-file.js";

/* Persisted user record. `id` is the AAD `oid` (stable across email/name
   changes). Roles are the source of truth for permissions in the DB-only
   role model. `teamsUserId` is captured later (Phase 3) for bot DMs. */
export interface PersistedUser {
  id: string;
  email?: string;
  displayName: string;
  roles: UserRole[];
  /* Deactivated users keep their record + roles but are blocked at auth.
     Defaults to true; legacy records without the field are treated active. */
  active: boolean;
  teamsUserId?: string;
  createdAt: string;
  lastSeenAt: string;
}

interface DataShape {
  users: PersistedUser[];
}

const DEFAULT_ROLES: UserRole[] = ["LOAN_OFFICER"];

/* Legacy records predate `active`; treat a missing flag as active. */
const normalize = (user: PersistedUser): PersistedUser => ({
  ...user,
  active: user.active !== false
});

const toIdentity = (user: PersistedUser): UserIdentity => ({
  id: user.id,
  displayName: user.displayName,
  roles: user.roles,
  ...(user.email ? { email: user.email } : {})
});

/* Built on `JsonFile`, so a lookup waits behind a save (#339). That matters
   here more than it looks: the user record is saved on every authenticated
   request, so a lookup landing mid-save — and failing that request — was not a
   rare event. */
export class UserStore {
  private readonly file: JsonFile<DataShape>;

  constructor(filePath: string) {
    this.file = new JsonFile<DataShape>(filePath, {
      empty: () => ({ users: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<DataShape>;
        return { users: Array.isArray(raw.users) ? raw.users.map(normalize) : [] };
      }
    });
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  async list(): Promise<PersistedUser[]> {
    const data = await this.file.read();
    return data.users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async get(id: string): Promise<PersistedUser | undefined> {
    const data = await this.file.read();
    return data.users.find((user) => user.id === id);
  }

  /* Resolve an active user to a permission-bearing identity by AAD oid.
     Used by the bot's one-tap Claim action, where the only thing we know
     about the actor is `from.aadObjectId`. Inactive/unknown users return
     undefined so the claim is rejected. */
  async getIdentity(id: string): Promise<UserIdentity | undefined> {
    const user = await this.get(id);
    if (!user || user.active === false) {
      return undefined;
    }
    return toIdentity(normalize(user));
  }

  /* Create-or-update on every authenticated request. Returns the resolved
     identity WITH roles. Role resolution:
       - dev/header path (identity.headerRoles set): header roles are
         authoritative, so local mock-user switching keeps working.
       - token path, existing user: keep stored roles (admin-managed).
       - token path, new user: default LOAN_OFFICER (promote via admin). */
  async upsertOnLogin(identity: AuthIdentity): Promise<UserIdentity> {
    let resolved!: UserIdentity;
    await this.file.update((data) => {
      const now = new Date().toISOString();
      const index = data.users.findIndex((user) => user.id === identity.id);
      const existing = index >= 0 ? data.users[index] : undefined;

      const roles = identity.headerRoles ?? existing?.roles ?? DEFAULT_ROLES;
      const email = identity.email ?? existing?.email;
      const record: PersistedUser = {
        id: identity.id,
        displayName: identity.displayName,
        roles,
        active: existing?.active ?? true,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        ...(email ? { email } : {}),
        ...(existing?.teamsUserId ? { teamsUserId: existing.teamsUserId } : {})
      };

      if (index >= 0) {
        data.users[index] = record;
      } else {
        data.users.push(record);
      }
      resolved = toIdentity(record);
      return data;
    });
    return resolved;
  }

  /* Admin role management (onboarding + future admin UI). */
  async setRoles(id: string, roles: UserRole[]): Promise<PersistedUser | undefined> {
    let updated: PersistedUser | undefined;
    await this.file.update((data) => {
      const index = data.users.findIndex((user) => user.id === id);
      if (index < 0) {
        return undefined;
      }
      data.users[index] = { ...data.users[index]!, roles };
      updated = data.users[index];
      return data;
    });
    return updated;
  }

  /* Capture the Teams user id for bot DMs (Phase 3). */
  async setTeamsUserId(id: string, teamsUserId: string): Promise<void> {
    await this.file.update((data) => {
      const index = data.users.findIndex((user) => user.id === id);
      if (index < 0) {
        return undefined;
      }
      data.users[index] = { ...data.users[index]!, teamsUserId };
      return data;
    });
  }

  /* Onboarding seed: upsert a user with explicit roles (id = AAD oid). */
  async seed(entry: { id: string; displayName: string; email?: string; roles: UserRole[] }): Promise<void> {
    await this.file.update((data) => {
      const now = new Date().toISOString();
      const index = data.users.findIndex((user) => user.id === entry.id);
      const existing = index >= 0 ? data.users[index] : undefined;
      const email = entry.email ?? existing?.email;
      const record: PersistedUser = {
        id: entry.id,
        displayName: entry.displayName,
        roles: entry.roles,
        active: existing?.active ?? true,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: existing?.lastSeenAt ?? now,
        ...(email ? { email } : {}),
        ...(existing?.teamsUserId ? { teamsUserId: existing.teamsUserId } : {})
      };
      if (index >= 0) {
        data.users[index] = record;
      } else {
        data.users.push(record);
      }
      return data;
    });
  }

  /* Admin: add a user resolved from Entra (Graph). Fails if id already
     exists so the caller can surface a clear conflict. */
  async createByAdmin(entry: { id: string; displayName: string; email?: string; roles: UserRole[] }): Promise<PersistedUser> {
    let created!: PersistedUser;
    let conflict = false;
    await this.file.update((data) => {
      if (data.users.some((user) => user.id === entry.id)) {
        conflict = true;
        return undefined;
      }
      const now = new Date().toISOString();
      created = {
        id: entry.id,
        displayName: entry.displayName,
        roles: entry.roles.length > 0 ? entry.roles : DEFAULT_ROLES,
        active: true,
        createdAt: now,
        lastSeenAt: now,
        ...(entry.email ? { email: entry.email } : {})
      };
      data.users.push(created);
      return data;
    });
    if (conflict) {
      throw new Error("User already exists");
    }
    return created;
  }

  /* Admin: activate / deactivate. */
  async setActive(id: string, active: boolean): Promise<PersistedUser | undefined> {
    let updated: PersistedUser | undefined;
    await this.file.update((data) => {
      const index = data.users.findIndex((user) => user.id === id);
      if (index < 0) {
        return undefined;
      }
      data.users[index] = { ...data.users[index]!, active };
      updated = data.users[index];
      return data;
    });
    return updated;
  }

  /* Admin: permanently remove a user. Returns true if a record was deleted. */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.file.update((data) => {
      const next = data.users.filter((user) => user.id !== id);
      removed = next.length !== data.users.length;
      return removed ? { users: next } : undefined;
    });
    return removed;
  }
}
