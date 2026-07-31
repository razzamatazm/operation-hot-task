import { Loan } from "./types.js";

/* Loan matching / dedup (ADR-0001). Pure, dependency-free helpers so the
   create path, the migration, and their sim tests all share one definition
   of "these two loan names are the same thing". */

/* Canonical form for comparison: lowercase, strip punctuation to spaces,
   collapse whitespace. "Smith - 1042 (rev)" -> "smith 1042 rev". */
export const normalizeLoanName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/* Canonical form for a Humperdink link so trivially-different spellings of
   the same URL collapse to one key (case-insensitive host, no trailing
   slash, drop a leading www.). Returns "" for an empty/whitespace link. */
export const normalizeLinkKey = (link: string | undefined): string => {
  const value = (link ?? "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.host.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}${url.search}`.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/\/+$/, "");
  }
};

/* Levenshtein edit distance between two already-normalized strings. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
};

/* Similarity in [0,1] between two loan names, after normalization. 1 = the
   same canonical string; scales down with edit distance relative to length. */
export const loanNameSimilarity = (a: string, b: string): number => {
  const na = normalizeLoanName(a);
  const nb = normalizeLoanName(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  const longer = Math.max(na.length, nb.length);
  return (longer - editDistance(na, nb)) / longer;
};

/* Default threshold above which two names are treated as the same loan. */
export const LOAN_MATCH_THRESHOLD = 0.82;

/* Ordered list of digit-runs in a name ("ABC Corp 1002 Rev 3" -> ["1002","3"],
   "Johnson-4821" -> ["4821"], "Acme Corp" -> []). A loan's file/serial number
   is identity, not spelling: two names that differ only in their digits name
   two different loans, however similar the surrounding text. */
export const loanDigitSignature = (name: string): string[] => name.match(/\d+/g) ?? [];

/* True when two names carry the same ordered digit-runs (both empty counts).
   The migration only fuzzy-merges names that agree here — so sequential/
   numbered variants like "ABC Corp 1001" vs "ABC Corp 1002" are never merged,
   while pure typo/spacing variants (no digit change) still can be. */
const sameDigitSignature = (a: string, b: string): boolean => {
  const da = loanDigitSignature(a);
  const db = loanDigitSignature(b);
  return da.length === db.length && da.every((digits, i) => digits === db[i]);
};

export interface LoanMatch {
  loan: Loan;
  score: number;
}

/* Rank loans for the create-form typeahead. Matches on fuzzy name AND
   substring (so "smi" surfaces "Smith 1042" even though edit-distance is
   low), newest/most-similar first. Empty query returns the most recent loans. */
export const searchLoans = (query: string, loans: Loan[], limit = 8): LoanMatch[] => {
  const q = normalizeLoanName(query);
  if (q.length === 0) {
    return [...loans]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((loan) => ({ loan, score: 0 }));
  }
  const scored: LoanMatch[] = [];
  for (const loan of loans) {
    const candidates = [loan.name, ...(loan.aliases ?? [])];
    let best = 0;
    for (const candidate of candidates) {
      const nc = normalizeLoanName(candidate);
      let score = loanNameSimilarity(query, candidate);
      if (nc.includes(q) || q.includes(nc)) {
        // Substring hit — floor the score high so prefix/typeahead matches
        // always surface, longer overlaps ranking above shorter ones.
        score = Math.max(score, 0.6 + 0.4 * (q.length / Math.max(nc.length, q.length)));
      }
      best = Math.max(best, score);
    }
    if (best > 0.3) {
      scored.push({ loan, score: best });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || b.loan.updatedAt.localeCompare(a.loan.updatedAt))
    .slice(0, limit);
};

/* Derive the set of loan ids that are "mine" — a loan is mine if any task I
   created links it (issue #55). Loans folded together via a shared Humperdink
   link/alias share one canonical id, so a task I created that references the
   merged loan counts it as mine automatically (no owner field on Loan). */
export const deriveMyLoanIds = (
  tasks: Array<{ loanId?: string; createdBy: { id: string } }>,
  userId: string
): Set<string> => {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.loanId && task.createdBy.id === userId) ids.add(task.loanId);
  }
  return ids;
};

/* Suggestions for the create-form Folder Name typeahead (issue #55). Two modes:
   - Empty query (open-on-focus shortlist): scope to the current user's loans
     (`myLoanIds`), most-recently-used first.
   - Typed query: search ALL users' loans, ranked by match score then MRU.
   Delegates ranking to `searchLoans` in both modes; only the candidate set
   differs. */
export const loanTypeaheadSuggestions = (
  query: string,
  loans: Loan[],
  myLoanIds: Set<string>,
  limit = 8
): LoanMatch[] => {
  if (normalizeLoanName(query).length === 0) {
    const mine = loans.filter((loan) => myLoanIds.has(loan.id));
    return searchLoans("", mine, limit);
  }
  return searchLoans(query, loans, limit);
};

/* Move the keyboard highlight over a suggestion list of `count` items (issue
   #55). `current` is the highlighted index or -1 for none. ArrowDown/ArrowUp
   wrap around the ends; from "none" ArrowDown lands on the first item and
   ArrowUp on the last. Returns -1 when the list is empty. */
export const nextHighlightIndex = (
  current: number,
  direction: 1 | -1,
  count: number
): number => {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
};

/* Find an existing loan a new (name, link) should fold into rather than
   creating a duplicate. Link is the canonical key: an exact normalized-link
   match wins outright. Otherwise fall back to an exact normalized-name match.
   Deliberately does NOT auto-merge on fuzzy name alone — that's the UI
   typeahead's job at create time; server-side fuzzy merging risks collapsing
   genuinely distinct loans. */
export const findLoanForCreate = (
  name: string,
  link: string | undefined,
  loans: Loan[]
): Loan | undefined => {
  const linkKey = normalizeLinkKey(link);
  if (linkKey) {
    const byLink = loans.find((loan) => normalizeLinkKey(loan.humperdinkLink) === linkKey);
    if (byLink) return byLink;
  }
  const nameKey = normalizeLoanName(name);
  if (nameKey) {
    const byName = loans.find(
      (loan) =>
        normalizeLoanName(loan.name) === nameKey ||
        (loan.aliases ?? []).some((alias) => normalizeLoanName(alias) === nameKey)
    );
    if (byName) return byName;
  }
  return undefined;
};

export interface LoanCluster {
  /** Canonical display name for the cluster (first-seen spelling). */
  name: string;
  /** All source names that fell into this cluster, in first-seen order. */
  members: string[];
  /** A Humperdink link seen for any member, if any. */
  humperdinkLink?: string;
}

/* Fuzzy-dedup a flat list of (folderName, link) pairs into loan clusters for
   the one-time migration. Greedy single-pass clustering: each name joins the
   first existing cluster it's similar enough to, else starts a new one. Fuzzy
   name matching is gated on an identical digit signature (see
   `sameDigitSignature`) so numbered/serial variants stay distinct; only a
   shared normalized link forces a merge regardless of name or number. */
export const clusterLoanNames = (
  entries: Array<{ name: string; humperdinkLink?: string }>,
  threshold = LOAN_MATCH_THRESHOLD
): LoanCluster[] => {
  const clusters: LoanCluster[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    const linkKey = normalizeLinkKey(entry.humperdinkLink);
    let target: LoanCluster | undefined;
    if (linkKey) {
      target = clusters.find((c) => normalizeLinkKey(c.humperdinkLink) === linkKey);
    }
    if (!target) {
      // Fuzzy-merge only genuine typo/spacing variants of the same text — never
      // across a differing file/serial number, which denotes a distinct loan.
      target = clusters.find((c) =>
        c.members.some(
          (member) => sameDigitSignature(member, name) && loanNameSimilarity(member, name) >= threshold
        )
      );
    }
    if (target) {
      target.members.push(name);
      if (!target.humperdinkLink && entry.humperdinkLink) {
        target.humperdinkLink = entry.humperdinkLink;
      }
    } else {
      clusters.push({
        name,
        members: [name],
        ...(entry.humperdinkLink ? { humperdinkLink: entry.humperdinkLink } : {})
      });
    }
  }
  return clusters;
};
