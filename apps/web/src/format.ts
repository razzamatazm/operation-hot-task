/* ── Display formatting shared by App.tsx and the card's thread ──────────── */
/* These three lived in App.tsx until #258 lifted the terms section and the
   message list out into `thread.tsx` so a node test could render them. Both
   files need them, and App.tsx cannot be imported into a node script, so they
   sit here rather than in either. Nothing in here knows about a task. */

/* "Aug 21, 2026, 9:39 AM" — the app's one long-form timestamp. */
export const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
};

/* Two-letter initials for the compact avatar chips, "Suzie Lim" → "SL". */
export const initialsOf = (name?: string): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const letters = parts.map((p) => p[0] ?? "").join("");
  return (letters.slice(0, 2) || "?").toUpperCase();
};

/* "5m ago", "3h ago", "2d ago" — rounded, never more precise than a glance
   needs. Lived in App.tsx for the admin user list's "last seen" until the Saved
   for Later rows (#343) needed it too, in a module a node test can render.
   `now` is passed in where the caller already ticks one, so a row does not
   read a different clock from the list around it. */
export const formatAgo = (iso?: string, now: number = Date.now()): string => {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(diff / 3600000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diff / 86400000);
  return `${day}d ago`;
};

/* "Heather Finn - Aug 21, 2026, 9:39 AM" — one string, used twice per note:
   the row's hover title and its visually-hidden label. Both have to say the
   same thing, so they read it from the same place. */
export const bylineOf = (name: string, iso: string): string => `${name} - ${formatDate(iso)}`;
