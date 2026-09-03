/* The Humperdink → Hot Task clipboard contract (issue #194, parent #179).

   Humperdink is the loan app ops staff already have open; it is old software
   with no API, so the only way a loan crosses into Hot Task is the human's
   clipboard. A userscript on the loan details page
   (`tools/humperdink/send-to-hot-task.user.js`) scrapes the page, JSON-encodes
   it into this shape and copies it; the create form parses it back with
   `parseHumperdinkPayload` and fills its fields.

   Reading the clipboard programmatically is deliberately not done — the human
   presses paste. Clipboard-read permission inside the Teams webview is the kind
   of thing that works in dev and fails in production.

   ## Versioning

   `version` is on the wire from the first release because the userscript is
   self-installed: at any moment the scripts in the field and the deployed web
   app are different ages, in both directions. The rules:

   - **Additive changes keep the version.** New fields are optional; a parser
     ignores fields it doesn't know, and a filler skips fields that aren't
     there. Issues #196 and #197 extend the payload this way — nothing here
     bumps for them.
   - **Bump only on a break** — a field removed, renamed, or given a new
     meaning. `SUPPORTED_PAYLOAD_VERSION` then rises with it, and a payload
     above it is rejected with "update Hot Task", not silently half-read.
   - `kind` exists so a random clipboard paste is told apart from a payload we
     can't handle. The two get different messages.

   Pure and dependency-free, so it type-strips straight into a node test. */

/** Marks clipboard text as ours. Never changes; that is the point of it. */
export const HUMPERDINK_PAYLOAD_KIND = "hot-task-humperdink";

/** The version the userscript in this repo writes. */
export const HUMPERDINK_PAYLOAD_VERSION = 1;

/** The highest version this app can read. See the versioning rules above. */
export const SUPPORTED_HUMPERDINK_PAYLOAD_VERSION = 1;

/** Every Humperdink loan details URL has the path `/Loans/Details/<id>`.
    Anchored on purpose — an unanchored match calls
    `https://evil.example/x/Loans/Details/1` a loan page. */
export const LOAN_DETAILS_PATH = /^\/Loans\/Details\/[^/]+\/?$/i;

/** Humperdink titles its loan details page `<LoanName> - Details`. */
export const LOAN_TITLE_SUFFIX = " - Details";

export interface HumperdinkPayload {
  kind: typeof HUMPERDINK_PAYLOAD_KIND;
  version: number;
  /** The loan's name, off the page title. Fills Folder Name. */
  loanName: string;
  /**
   * The loan details page URL, origin + path only. Fills the Humperdink Link,
   * and is the canonical unique key for a Loan (ADR-0001) — so a task created
   * from an import links to the existing Loan for that URL rather than minting
   * a duplicate.
   */
  loanUrl: string;
}

export type HumperdinkParseResult =
  | { ok: true; payload: HumperdinkPayload }
  | { ok: false; error: string };

/* Every message is written to be read by the person who just pressed Import,
   so each one says what to do next rather than naming the field that failed. */
const NOT_OURS =
  "That isn't a Humperdink payload. Press Send to Hot Task on the loan page, then paste here.";

/** Pull the loan name out of a page title, or "" when the title isn't one. */
export const loanNameFromPageTitle = (title: string | null | undefined): string => {
  const text = (title ?? "").trim();
  const suffix = LOAN_TITLE_SUFFIX.toLowerCase();
  if (!text.toLowerCase().endsWith(suffix)) return "";
  return text.slice(0, text.length - suffix.length).trim();
};

/* True when a URL points at a Humperdink loan details page.

   Three separate gates, because this value does not stop at the form: it fills
   `humperdinkLink`, becomes the canonical key for a Loan (ADR-0001), and is
   rendered as an `href` on every card for that loan. A pasted payload is
   attacker-supplied text — the human copied it from a page we don't control —
   so `javascript:` and a lookalike path buried inside some other site's URL
   both have to fail here rather than at the `<a>`.

   The host deliberately isn't checked: Humperdink's hostname isn't configured
   anywhere in the app, and the field has always accepted a typed URL. */
export const isLoanDetailsUrl = (url: string | null | undefined): boolean => {
  const value = (url ?? "").trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return LOAN_DETAILS_PATH.test(parsed.pathname);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/* Parse clipboard text into a payload, or explain why it isn't one.

   Never throws and never returns a half-payload: a caller that gets `ok: false`
   leaves the form exactly as it was. That is the whole reason this returns a
   result rather than `HumperdinkPayload | null` — "it failed" is not enough to
   tell the filer, who has no console open. */
export const parseHumperdinkPayload = (text: string | null | undefined): HumperdinkParseResult => {
  const raw = (text ?? "").trim();
  if (!raw) {
    return { ok: false, error: "Nothing to import — paste what Send to Hot Task copied." };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: NOT_OURS };
  }

  if (!isRecord(decoded) || decoded.kind !== HUMPERDINK_PAYLOAD_KIND) {
    return { ok: false, error: NOT_OURS };
  }

  // Past this point the paste IS ours, so nothing below tells the filer to go
  // and press Send to Hot Task — they already did. Every message from here on
  // is about the payload, not about where payloads come from.
  const version = decoded.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return {
      ok: false,
      error: "That payload doesn't say which version it is. Re-copy it with an up-to-date Send to Hot Task script."
    };
  }
  if (version > SUPPORTED_HUMPERDINK_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: `That payload came from a newer Send to Hot Task script (v${version}). Hot Task reads up to v${SUPPORTED_HUMPERDINK_PAYLOAD_VERSION} — it needs updating.`
    };
  }

  const loanName = nonEmptyString(decoded.loanName);
  const loanUrl = nonEmptyString(decoded.loanUrl);
  if (!loanName || !loanUrl) {
    return {
      ok: false,
      error: "That payload is missing the loan name or its link. Re-copy it from the loan page."
    };
  }
  if (!isLoanDetailsUrl(loanUrl)) {
    return {
      ok: false,
      error: "That payload's link isn't a Humperdink loan page. Re-copy it from the loan page."
    };
  }

  // Rebuilt field by field rather than passed through: unknown keys from a
  // newer additive payload are dropped here, which is what makes "additive
  // changes keep the version" safe.
  return { ok: true, payload: { kind: HUMPERDINK_PAYLOAD_KIND, version, loanName, loanUrl } };
};
