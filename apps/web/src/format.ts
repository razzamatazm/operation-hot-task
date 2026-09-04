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

/* "Heather Finn - Aug 21, 2026, 9:39 AM" — one string, used twice per note:
   the row's hover title and its visually-hidden label. Both have to say the
   same thing, so they read it from the same place. */
export const bylineOf = (name: string, iso: string): string => `${name} - ${formatDate(iso)}`;
