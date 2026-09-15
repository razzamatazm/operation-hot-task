/* The Humperdink → Hot Task clipboard contract (issue #194, parent #179).

   Humperdink is the loan app ops staff already have open; it is old software
   with no API, so the only way a loan crosses into Hot Task is the human's
   clipboard. A userscript on the loan details page
   (`tools/humperdink/send-to-hot-task.user.js`) scrapes the page, JSON-encodes
   it into this shape and copies it; the create form parses it back with
   `parseHumperdinkPayload` and fills its fields.

   The human's paste into any field on an LOI Check being filed is the import. The one
   other way in is a Humperdink arrival (#415, ADR-0012): the tab reads the
   clipboard through Teams, where Teams supports it, and runs the same import on
   it. Either way this parser is the guard, and only a payload it accepts fills
   anything.

   ## Versioning

   `version` is on the wire from the first release because the userscript is
   self-installed: at any moment the scripts in the field and the deployed web
   app are different ages, in both directions. The rules:

   - **Additive changes keep the version.** New fields are optional; a parser
     ignores fields it doesn't know, and a filler skips fields that aren't
     there. Issues #196 and #197 extend the payload this way — nothing here
     bumps for them.
   - **#442 went to version 2.** Besides adding fields, it gave `properties` a
     new meaning: every property on the loan, not only the ones being
     acquired. A version 1 app would have read that without complaint and
     printed refinances under "Properties Acquired". A version 1 payload from a
     script that hasn't updated yet still reads here.
   - **Bump only on a break** — a field removed, renamed, or given a new
     meaning. `SUPPORTED_PAYLOAD_VERSION` then rises with it, and a payload
     above it is rejected with "update Hot Task", not silently half-read.
   - `kind` exists so a random clipboard paste is told apart from a payload we
     can't handle. The two get different messages.

   Pure and dependency-free, so it type-strips straight into a node test. */

/** Marks clipboard text as ours. Never changes; that is the point of it. */
export const HUMPERDINK_PAYLOAD_KIND = "hot-task-humperdink";

/** The version the userscript in this repo writes. */
export const HUMPERDINK_PAYLOAD_VERSION = 2;

/** The highest version this app can read. See the versioning rules above. */
export const SUPPORTED_HUMPERDINK_PAYLOAD_VERSION = 2;

/** Every Humperdink loan details URL has the path `/Loans/Details/<id>`.
    Anchored on purpose — an unanchored match calls
    `https://evil.example/x/Loans/Details/1` a loan page. */
export const LOAN_DETAILS_PATH = /^\/Loans\/Details\/[^/]+\/?$/i;

/** Humperdink titles its loan details page `<LoanName> - Details`. */
export const LOAN_TITLE_SUFFIX = " - Details";

/** One row of Humperdink's interest rate table: a month range at a rate.
    Every loan has at least one; a stepped loan has several. */
export interface HumperdinkRateTier {
  startMonth: string;
  endMonth: string;
  rate: string;
}

/** One row of Humperdink's extensions table (#442): a month range at a rate,
    for a fee in points. A loan has none, one or several. */
export interface HumperdinkExtension {
  startMonth: string;
  endMonth: string;
  rate: string;
  /** "" when the row carries no fee. */
  points: string;
}

/* The loan's terms, exactly as Humperdink displays them (issue #196).

   Every field is a **display string**, not a number — `"$1,300,000"`,
   `"39.87%"`, `"2.0000"`. Humperdink has already formatted these for the desk
   that reads them, and the note is for a human, so parsing them into numbers
   here would only mean formatting them back again, differently.

   Every field is optional, and an absent field means "this loan doesn't have
   one", not "the scrape failed". The scrape reports a field whose *element* is
   missing from the page (see the userscript's `collect`); a field whose element
   is there and empty simply doesn't travel, which is what keeps a plain loan
   from producing a note full of empty labels.

   The excluded set from #196 is enforced by this type having no home for it:
   loan-amount-requested, term-requested, reason for loan, exit strategy,
   borrower real estate experience, red flags, the loan-level lender, status and
   closing date are deliberately absent. (A contact whose type is Lender does
   travel, since #442, but as a contact.) */
export interface HumperdinkTerms {
  /* Core: the terms panel's headline figures. */
  loanAmount?: string;
  termMonths?: string;
  rateTiers?: HumperdinkRateTier[];
  originationFeePoints?: string;
  brokerFeePoints?: string;
  evaluationFee?: string;
  loanTermNotes?: string;

  /* Conditional: panels with an on/off switch, sent only while it's on (#442). */
  extensions?: HumperdinkExtension[];
  extensionNotes?: string;
  /** `"Permitted"` when the switch is on and no junior figure is filled in. */
  juniorFinancingPermitted?: string;
  juniorFinancingAmount?: string;
  juniorFinancingRate?: string;
  juniorFinancingPoints?: string;
  juniorFinancingFee?: string;
  /** Humperdink renders total loan and CLTV into one field, e.g. `"$1.3M / 0"`. */
  combinedLoanAndCltv?: string;
  blendedRate?: string;
  blendedPoints?: string;
  blendedFee?: string;
  /** `"Permitted"` when the switch is on and no amount is filled in. */
  sellerFinancingPermitted?: string;
  sellerFinancingAmount?: string;
  initialAdvance?: string;
  drawMinimum?: string;
  drawIncrement?: string;
  interestReserveAmount?: string;
  interestReserveMonths?: string;
  partialReconveyance?: string;
}

/* One person off Humperdink's contact grid (issue #197).

   `type` is the contact type text as the grid displays it — `"Broker"`,
   `"Borrower"`, `"Silent Borrower"`, `"Lender"` — and it is what the scrape
   matched on.
   It is kept as text, not a closed union: the userscript decides which types
   travel, and the note prints whatever it sent under its own name, so a type
   added there needs nothing here. Humperdink's row ids are positional
   (`row0ContactsGrid`), so anything that matched on those would point at the
   wrong person the moment somebody adds a contact. */
export interface HumperdinkContact {
  type: string;
  name: string;
}

/* One property on the loan (issues #197, #442).

   Street address, transaction type, and the purchase and release prices that
   go with it. There is no loan-level purchase price in Humperdink — it exists
   per property — and the rest of the property grid (parcel, property type,
   existing debt, final value) is not what an LOI check needs. */
export interface HumperdinkProperty {
  address: string;
  /** As Humperdink words it, e.g. `"Refinance-Standard"`. Absent from a pre-#442 script. */
  transactionType?: string;
  /** Absent when the desk hasn't filled one in. */
  purchasePrice?: string;
  /** Off the property's details, as dollars. Absent when none is set, or from a pre-#442 script. */
  releasePrice?: string;
}

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
  /**
   * The loan's terms (#196), rendered into the notes field. Optional because a
   * payload from a pre-#196 userscript has none, and an import from one must
   * still fill the name and the link.
   */
  terms?: HumperdinkTerms;
  /**
   * The loan's brokers, borrowers, silent borrowers (#197) and lenders (#442),
   * grouped in that order, every one of each. Only those types travel; the rest of
   * Humperdink's contact grid stays there. The note prints them in the order
   * they arrive.
   */
  contacts?: HumperdinkContact[];
  /**
   * Every property on the loan, whatever its transaction (#442). A payload
   * from a pre-#442 script carries only the ones being acquired (#197).
   */
  properties?: HumperdinkProperty[];
}

/* `ours` on a failure says whether the text carried the export's own `kind` at
   all. The create form has no paste box, so every paste on an LOI Check comes
   through here: a stray paste (`ours: false`) is let through silently, and an
   export it can't read (`ours: true`) is refused with `error`. */
export type HumperdinkParseResult =
  | { ok: true; payload: HumperdinkPayload }
  | { ok: false; error: string; ours: boolean };

/* Every message is written to be read by the person who just pasted, so each
   one says what to do next rather than naming the field that failed. The
   button it names is the label the userscript's control wears in Humperdink's
   Loan Terms header. */
const NOT_OURS =
  "That isn't a Humperdink payload. Press Export to HT on the loan page, then paste here.";

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

/* ── Terms: reading them off the wire ───────────────────── */

/** A single term's display string. Longer than this is not a loan term, it is
    someone's essay pasted into the wrong box, and the note has to stay
    readable. Free-text fields get `FREE_TEXT_CAP` instead. */
const TERM_VALUE_CAP = 300;
/** Humperdink's own `maxlength` on its Loan Terms textareas. The extension
    notes box gets the same. */
const FREE_TEXT_CAP = 1000;
/** Humperdink's rate table has an Add button and no ceiling. This one does. */
const MAX_RATE_TIERS = 12;
/** The same for its extensions table. */
const MAX_EXTENSIONS = 12;

const termValue = (value: unknown, cap = TERM_VALUE_CAP): string =>
  nonEmptyString(value).slice(0, cap);

/* Every term, in the order it reads in the note.

   One table, two readers: `readTerms` rebuilds the payload from it and
   `humperdinkNoteSections` renders from it. Written once because the two
   drifting apart is silent — a field added to `HumperdinkTerms` and to the
   userscript but forgotten in the renderer would cross the wire and never
   appear, and `tsc` has nothing to say about it.

   `heading` groups consecutive entries into a block, so the order here IS the
   order of the terms within the note. #197's contacts come before these and
   its properties after, as whole blocks rather than among them. */
interface TermFieldSpec {
  field: Exclude<keyof HumperdinkTerms, "rateTiers" | "extensions">;
  heading: string;
  label: string;
  /** Appended after the value, e.g. `Term: 24 months`. */
  unit?: string;
  /** Prose the desk typed: its own block, and it keeps its own newlines. */
  prose?: true;
  /** Left out of the note when the value is zero. */
  hideZero?: true;
}

/* Total Value and LTV are deliberately absent: the desk doesn't use them on an
   LOI check. A payload from an older script that still carries them has them
   dropped by `readTerms`, which only reads what is listed here. */
const TERM_FIELDS: readonly TermFieldSpec[] = [
  { field: "loanAmount", heading: "Loan Terms", label: "Loan Amount" },
  { field: "termMonths", heading: "Loan Terms", label: "Term", unit: "months" },
  /* The rate tiers render here, between Term and the fees — see
     `RATE_TIER_AFTER` and the renderer below. */
  { field: "originationFeePoints", heading: "Loan Terms", label: "Origination Fee", unit: "points" },
  /* A loan with no broker says nothing about a broker fee, rather than
     `Broker Fee: 0.0000 points`. */
  { field: "brokerFeePoints", heading: "Loan Terms", label: "Broker Fee", unit: "points", hideZero: true },
  { field: "evaluationFee", heading: "Loan Terms", label: "Evaluation Fee" },
  /* Straight after the Loan Terms, so a term's length and its extensions read
     together. The extension rows render ahead of these notes, in the same
     block — see `EXTENSIONS_BEFORE`. */
  { field: "extensionNotes", heading: "Extensions", label: "Extension Notes", prose: true },
  { field: "loanTermNotes", heading: "Loan Term Notes", label: "Loan Term Notes", prose: true },
  { field: "juniorFinancingPermitted", heading: "Junior Financing", label: "Junior Financing" },
  { field: "juniorFinancingAmount", heading: "Junior Financing", label: "Amount" },
  { field: "juniorFinancingRate", heading: "Junior Financing", label: "Rate" },
  { field: "juniorFinancingPoints", heading: "Junior Financing", label: "Points" },
  { field: "juniorFinancingFee", heading: "Junior Financing", label: "Fee" },
  { field: "combinedLoanAndCltv", heading: "Blended Totals", label: "Total Loan / CLTV" },
  { field: "blendedRate", heading: "Blended Totals", label: "Blended Rate" },
  { field: "blendedPoints", heading: "Blended Totals", label: "Blended Points" },
  { field: "blendedFee", heading: "Blended Totals", label: "Blended Fee" },
  { field: "sellerFinancingPermitted", heading: "Seller Financing", label: "Seller Financing" },
  { field: "sellerFinancingAmount", heading: "Seller Financing", label: "Amount" },
  { field: "initialAdvance", heading: "Disbursement Options", label: "Initial Advance" },
  { field: "drawMinimum", heading: "Disbursement Options", label: "Draw Minimum" },
  { field: "drawIncrement", heading: "Disbursement Options", label: "Increment" },
  { field: "interestReserveAmount", heading: "Interest Reserve", label: "Amount" },
  { field: "interestReserveMonths", heading: "Interest Reserve", label: "Months" },
  { field: "partialReconveyance", heading: "Partial Reconveyance", label: "Partial Reconveyance", prose: true }
];

/** The rate tiers render straight after this field, as `Interest Rate` lines. */
const RATE_TIER_AFTER: TermFieldSpec["field"] = "termMonths";
const RATE_TIER_LABEL = "Interest Rate";

/** The extension rows render straight before this field, in its block. */
const EXTENSIONS_BEFORE: TermFieldSpec["field"] = "extensionNotes";

const readExtensions = (value: unknown): HumperdinkExtension[] => {
  if (!Array.isArray(value)) return [];
  const extensions: HumperdinkExtension[] = [];
  for (const entry of value) {
    if (extensions.length >= MAX_EXTENSIONS) break;
    if (!isRecord(entry)) continue;
    const extension = {
      startMonth: termValue(entry.startMonth),
      endMonth: termValue(entry.endMonth),
      rate: termValue(entry.rate),
      points: termValue(entry.points)
    };
    if (extension.startMonth || extension.endMonth || extension.rate || extension.points) extensions.push(extension);
  }
  return extensions;
};

const readRateTiers = (value: unknown): HumperdinkRateTier[] => {
  if (!Array.isArray(value)) return [];
  const tiers: HumperdinkRateTier[] = [];
  for (const entry of value.slice(0, MAX_RATE_TIERS)) {
    if (!isRecord(entry)) continue;
    const tier = {
      startMonth: termValue(entry.startMonth),
      endMonth: termValue(entry.endMonth),
      rate: termValue(entry.rate)
    };
    // A row with nothing in it is a row Humperdink drew and nobody filled.
    if (tier.startMonth || tier.endMonth || tier.rate) tiers.push(tier);
  }
  return tiers;
};

/* Read the terms out of a decoded payload, dropping anything empty.

   Never fails: terms are additive (#196), so a payload with no terms, junk
   terms, or terms from a newer script all leave the import working on the name
   and the link that #194 established. */
const readTerms = (value: unknown): HumperdinkTerms | undefined => {
  if (!isRecord(value)) return undefined;
  const terms: HumperdinkTerms = {};
  for (const spec of TERM_FIELDS) {
    const text = termValue(value[spec.field], spec.prose ? FREE_TEXT_CAP : TERM_VALUE_CAP);
    if (text) terms[spec.field] = text;
  }
  const rateTiers = readRateTiers(value.rateTiers);
  if (rateTiers.length > 0) terms.rateTiers = rateTiers;
  const extensions = readExtensions(value.extensions);
  if (extensions.length > 0) terms.extensions = extensions;
  return Object.keys(terms).length > 0 ? terms : undefined;
};

/* ── People and properties: reading them off the wire (#197) ── */

/** A loan's contact grid is a handful of people, not a mailing list. */
const MAX_CONTACTS = 20;
/** A loan can carry a lot of parcels; a note that carries all of them can't. */
const MAX_PROPERTIES = 40;

const readContacts = (value: unknown): HumperdinkContact[] => {
  if (!Array.isArray(value)) return [];
  const contacts: HumperdinkContact[] = [];
  for (const entry of value.slice(0, MAX_CONTACTS)) {
    if (!isRecord(entry)) continue;
    const type = termValue(entry.type);
    const name = termValue(entry.name);
    // A contact with no name is a row somebody started and abandoned.
    if (type && name) contacts.push({ type, name });
  }
  return contacts;
};

const readProperties = (value: unknown): HumperdinkProperty[] => {
  if (!Array.isArray(value)) return [];
  const properties: HumperdinkProperty[] = [];
  for (const entry of value.slice(0, MAX_PROPERTIES)) {
    if (!isRecord(entry)) continue;
    const address = termValue(entry.address);
    if (!address) continue;
    const transactionType = termValue(entry.transactionType);
    const purchasePrice = termValue(entry.purchasePrice);
    const releasePrice = termValue(entry.releasePrice);
    properties.push({
      address,
      ...(transactionType ? { transactionType } : {}),
      ...(purchasePrice ? { purchasePrice } : {}),
      ...(releasePrice ? { releasePrice } : {})
    });
  }
  return properties;
};

/* Parse clipboard text into a payload, or explain why it isn't one.

   Never throws and never returns a half-payload: a caller that gets `ok: false`
   leaves the form exactly as it was. That is the whole reason this returns a
   result rather than `HumperdinkPayload | null` — "it failed" is not enough to
   tell the filer, who has no console open. */
export const parseHumperdinkPayload = (text: string | null | undefined): HumperdinkParseResult => {
  const raw = (text ?? "").trim();
  if (!raw) {
    return { ok: false, error: "Nothing to import — paste what Export to HT copied.", ours: false };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: NOT_OURS, ours: false };
  }

  if (!isRecord(decoded) || decoded.kind !== HUMPERDINK_PAYLOAD_KIND) {
    return { ok: false, error: NOT_OURS, ours: false };
  }

  // Past this point the paste IS ours, so nothing below tells the filer to go
  // and press Export to HT — they already did. Every message from here on
  // is about the payload, not about where payloads come from.
  const version = decoded.version;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return {
      ok: false,
      error: "That payload doesn't say which version it is. Re-copy it with an up-to-date Send to Hot Task script.",
      ours: true
    };
  }
  if (version > SUPPORTED_HUMPERDINK_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: `That payload came from a newer Send to Hot Task script (v${version}). Hot Task reads up to v${SUPPORTED_HUMPERDINK_PAYLOAD_VERSION} — it needs updating.`,
      ours: true
    };
  }

  const loanName = nonEmptyString(decoded.loanName);
  const loanUrl = nonEmptyString(decoded.loanUrl);
  if (!loanName || !loanUrl) {
    return {
      ok: false,
      error: "That payload is missing the loan name or its link. Re-copy it from the loan page.",
      ours: true
    };
  }
  if (!isLoanDetailsUrl(loanUrl)) {
    return {
      ok: false,
      error: "That payload's link isn't a Humperdink loan page. Re-copy it from the loan page.",
      ours: true
    };
  }

  // Rebuilt field by field rather than passed through: unknown keys from a
  // newer additive payload are dropped here, which is what makes "additive
  // changes keep the version" safe.
  const terms = readTerms(decoded.terms);
  const contacts = readContacts(decoded.contacts);
  const properties = readProperties(decoded.properties);
  return {
    ok: true,
    payload: {
      kind: HUMPERDINK_PAYLOAD_KIND,
      version,
      loanName,
      loanUrl,
      ...(terms ? { terms } : {}),
      ...(contacts.length > 0 ? { contacts } : {}),
      ...(properties.length > 0 ? { properties } : {})
    }
  };
};

/* ── Terms: rendering them into the note ────────────────── */

/** One block of the imported note: a heading and the lines under it. */
export interface HumperdinkNoteSection {
  heading: string;
  lines: string[];
}

/** The two blocks #197 adds: contacts before the terms, properties after. */
const CONTACTS_HEADING = "Contacts";
const PROPERTIES_HEADING = "Properties";

/** `"0.0000"`, `"$0.00"`, `"0%"` — a displayed figure that means zero. */
const isZero = (value: string): boolean => {
  const digits = value.replace(/[$,%\s]/g, "");
  return digits !== "" && Number(digits) === 0;
};

/** One rate tier as a line: `Months 1–12 at 7.90%`. */
const rateTierLine = (tier: HumperdinkRateTier): string => {
  const span = tier.startMonth && tier.endMonth ? `Months ${tier.startMonth}–${tier.endMonth}` : "Months";
  return tier.rate ? `${span} at ${tier.rate}` : span;
};

/** One extension row as a line: `Months 1–6 at 8.90%, 1.00 points`. */
const extensionLine = (extension: HumperdinkExtension): string =>
  extension.points && !isZero(extension.points)
    ? `${rateTierLine(extension)}, ${extension.points} points`
    : rateTierLine(extension);

/** One property as a line:
    `15632 El Prado Road (Acquisition-Standard), Purchase Price $5,300,000, Release Price $2,950,000.00`. */
const propertyLine = (property: HumperdinkProperty): string =>
  [
    property.transactionType ? `${property.address} (${property.transactionType})` : property.address,
    ...(property.purchasePrice ? [`Purchase Price ${property.purchasePrice}`] : []),
    ...(property.releasePrice ? [`Release Price ${property.releasePrice}`] : [])
  ].join(", ");

/* Split the imported note into its blocks, in reading order.

   Walks `TERM_FIELDS` once, gathering consecutive entries that share a heading.
   A block that gathered no lines is dropped whole — that is all there is to "a
   loan with none of these produces no empty sections", because a term the loan
   doesn't have never reached the payload in the first place.

   Exported so #197's sections sit in the same list and so tests can assert the
   order without pattern-matching a wall of text. */
export const humperdinkNoteSections = (payload: HumperdinkPayload): HumperdinkNoteSection[] => {
  const sections: HumperdinkNoteSection[] = [];
  const push = (heading: string, text: string): void => {
    const open = sections[sections.length - 1];
    if (open && open.heading === heading) open.lines.push(text);
    else sections.push({ heading, lines: [text] });
  };

  /* Always the same order — the people, then the terms, then the properties.
     The broker and borrower lead because they are the first thing the checker
     looks for, and a note whose blocks moved around between two loans would be
     unreadable side by side. */
  for (const contact of payload.contacts ?? []) push(CONTACTS_HEADING, `${contact.type}: ${contact.name}`);

  const terms = payload.terms;
  if (terms) {
    for (const spec of TERM_FIELDS) {
      if (spec.field === EXTENSIONS_BEFORE) {
        for (const extension of terms.extensions ?? []) push(spec.heading, extensionLine(extension));
      }
      const raw = terms[spec.field];
      const value = raw && spec.hideZero && isZero(raw) ? "" : raw;
      /* Prose gets its own bare block rather than a `Label: …` line: it is what
         the desk typed and it carries its own newlines. */
      if (value) push(spec.heading, spec.prose ? value : `${spec.label}: ${value}${spec.unit ? ` ${spec.unit}` : ""}`);
      if (spec.field === RATE_TIER_AFTER) {
        for (const tier of terms.rateTiers ?? []) push(spec.heading, `${RATE_TIER_LABEL}: ${rateTierLine(tier)}`);
      }
    }
  }

  for (const property of payload.properties ?? []) {
    push(PROPERTIES_HEADING, propertyLine(property));
  }

  return sections;
};

/* Render note sections as plain text.

   Plain on purpose: the notes field renders as a text node with whitespace
   preserved and no markdown parsing, so newlines survive and `**bold**` would
   come out as four literal asterisks. Headings are bare lines and blocks are
   separated by a blank line — that is the whole formatting vocabulary
   available, and it is enough. */
const renderNoteSections = (sections: HumperdinkNoteSection[]): string =>
  sections.map((entry) => [entry.heading, ...entry.lines].join("\n")).join("\n\n");

/** The note text an imported loan writes, or "" when it carries no terms. */
export const humperdinkNoteText = (payload: HumperdinkPayload): string =>
  renderNoteSections(humperdinkNoteSections(payload));
