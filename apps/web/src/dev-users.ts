/* The local user switcher's roster, framework-free (#309).

   `App` used to carry the cast as a literal — Suzie, Alexa, Johanna — which
   drifted from the seed data the moment the seeder gained a fourth person. The
   roster now comes from the server's active-user directory, the same list the
   share and handoff pickers read, so it cannot go stale again.

   The switcher exists only in a local build, and getting the list is the one
   thing it has to do before it is anybody: every authenticated route registers
   its caller, so asking through one of them would mean inventing a placeholder
   person and writing them into the list being read. Hence `GET /dev/users`,
   which the server registers only when SSO is unconfigured and which takes no
   identity at all.

   Pure and type-only-imported so `scripts/dev-user-switcher-sim-test.mjs`
   type-strips it straight into node with no build. */
import type { UserRole } from "@loan-tasks/shared";

/* One person the switcher can become. Structurally the directory entry the
   pickers already use (`DirectoryUser` in task-form.tsx) — declared again here
   rather than imported because that module is a React component file, and
   pulling it in would cost this one its framework-free, type-strippable
   property. */
export interface SwitchableUser {
  id: string;
  displayName: string;
  roles: UserRole[];
}

/* Unauthenticated, dev-only. Absent from a deployed server (404), which is
   also why a failure here is silent: in prod nothing calls it. */
export const DEV_USERS_PATH = "/dev/users";

/* Read the roster. Any failure — no server, a 404 because SSO is configured,
   junk in the body — answers an empty roster, which the switcher renders as
   "still loading" and which `chooseDevUser` refuses to pick from. It never
   throws, so no caller has to decide what a broken dev server means. */
export const fetchDevUsers = async (
  apiBase: string,
  fetchImpl: typeof fetch = fetch
): Promise<SwitchableUser[]> => {
  try {
    const response = await fetchImpl(`${apiBase}${DEV_USERS_PATH}`);
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { users?: unknown };
    if (!Array.isArray(body.users)) {
      return [];
    }
    return body.users.filter(isSwitchableUser);
  } catch {
    return [];
  }
};

/* `npm run dev` starts the API and the web server at once, and vite is usually
   up first — so the first read can land before the server is listening. That
   used to cost nothing, because the app started as a hardcoded person; now an
   empty roster means an app that is nobody, with no way back but a reload. So
   retry a few times before giving up.

   Retries an EMPTY answer, not just a failed one: a server that is up but
   whose users file has no people yet reads exactly like one that isn't up. The
   sleep is injected so the test doesn't wait. */
export const DEV_ROSTER_ATTEMPTS = 5;
export const DEV_ROSTER_RETRY_MS = 1000;

export const loadDevUsers = async (
  apiBase: string,
  {
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    attempts = DEV_ROSTER_ATTEMPTS
  }: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
  } = {}
): Promise<SwitchableUser[]> => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const roster = await fetchDevUsers(apiBase, fetchImpl);
    if (roster.length > 0) {
      return roster;
    }
    if (attempt < attempts) {
      await sleep(DEV_ROSTER_RETRY_MS);
    }
  }
  return [];
};

const isSwitchableUser = (value: unknown): value is SwitchableUser => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const user = value as Partial<SwitchableUser>;
  return (
    typeof user.id === "string" &&
    user.id.length > 0 &&
    typeof user.displayName === "string" &&
    Array.isArray(user.roles)
  );
};

/* Who the app should be acting as, given the roster it just received and the
   id it is on now. Returns `null` for "don't touch the current identity".

   The two things #309 asks for live here:

   - **Nothing fires as a placeholder.** Before the roster lands the app holds
     an empty id, every request is gated on a non-empty one, and an empty
     roster leaves it that way rather than inventing somebody.
   - **The selected person survives the roster arriving.** A roster that still
     contains the current id re-selects that id, so a switch made while a
     second fetch was in flight is not undone. The record comes from the
     roster, not from what the caller held, so a renamed or re-roled person
     picks up their current details.

   A current id the roster does NOT contain means that person was deactivated
   (or never existed): fall to the head of the roster rather than keeping an
   identity the server would now refuse. */
export const chooseDevUser = (
  roster: readonly SwitchableUser[],
  currentId: string
): SwitchableUser | null => {
  if (roster.length === 0) {
    return null;
  }
  return roster.find((candidate) => candidate.id === currentId) ?? roster[0]!;
};
