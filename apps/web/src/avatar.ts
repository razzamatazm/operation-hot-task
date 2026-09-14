import type { CSSProperties } from "react";

/* Stable per-person color for every initials chip on a card: hashes the user
   id into one of 8 themed slots (--avatar-1..8 in styles.css) so the same
   person always gets the same chip color across rows and sessions. Lives
   outside App.tsx so thread.tsx, which a node script renders on its own, can
   draw the conversation's initials in the same colors as the header pair. */
const AVATAR_PALETTE_SIZE = 8;
export const avatarStyle = (id: string): CSSProperties => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const slot = (hash % AVATAR_PALETTE_SIZE) + 1;
  return { background: `var(--avatar-${slot})`, color: "var(--avatar-ink)", border: "none" };
};
