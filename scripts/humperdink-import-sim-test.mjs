#!/usr/bin/env node
/* The Humperdink → Hot Task clipboard hop, end to end (issue #194).

   Two halves of one contract, tested together on purpose:

   - `tools/humperdink/send-to-hot-task.user.js` — a Tampermonkey userscript,
     so a classic script that cannot import from this workspace. It carries its
     own copy of the payload constants.
   - `packages/shared/src/humperdink.ts` — the parser the create form uses.

   The round-trip tests below run the REAL userscript file in a `vm` realm with
   a hand-rolled DOM, take whatever it puts on the clipboard, and feed that to
   the real parser. That is what stops the duplicated constants drifting: the
   script cannot change shape without this going red.

   The parser is pure and dependency-free, so it type-strips straight in with no
   build. Run: `node --test scripts/humperdink-import-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  HUMPERDINK_PAYLOAD_KIND,
  HUMPERDINK_PAYLOAD_VERSION,
  SUPPORTED_HUMPERDINK_PAYLOAD_VERSION,
  humperdinkNoteSections,
  humperdinkNoteText,
  isLoanDetailsUrl,
  loanNameFromPageTitle,
  parseHumperdinkPayload
} from "../packages/shared/src/humperdink.ts";
import { readCreateFormIntent, teamsTaskDeepLink } from "../packages/shared/src/deep-link.ts";

const USERSCRIPT = readFileSync(new URL("../tools/humperdink/send-to-hot-task.user.js", import.meta.url), "utf8");

const LOAN_URL = "https://humperdink.loneoakfund.com/Loans/Details/335203";

/* ── The one line an installer fills in (#198) ────────────

   The control opens Hot Task's create form after it copies, which needs the
   Teams app id. A userscript has no config store, so the id is a constant at
   the top of the file — and the tests here have to be able to set it, so they
   rewrite that one line before running the script. The assertion is the point:
   rename or reshape the constant and this goes red rather than silently
   testing a script with no link in it. */
const APP_ID_LINE = /^(\s*var HOT_TASK_APP_ID = )"[^"]*";$/m;
/* The same line, capturing the value instead of the prefix, so a test can ask
   what the file actually ships with rather than restating it. */
const APP_ID_LINE_VALUE = /^\s*var HOT_TASK_APP_ID = "([^"]*)";$/m;

const userscriptWithAppId = (appId) => {
  assert.match(USERSCRIPT, APP_ID_LINE);
  return USERSCRIPT.replace(APP_ID_LINE, `$1${JSON.stringify(appId)};`);
};

/* ── The loan terms panel, as Humperdink renders it ──────

   Ids and values copied from a saved copy of a real loan details page (see
   tools/humperdink/README.md — the page itself is customer data and isn't
   committed). Every one of these is an `<input>` or `<textarea>` the scrape
   reads by id, so this map IS the selector contract: rename a key here and the
   userscript has to change with it.

   The conditional panels are included at the values Humperdink gives a loan
   that doesn't use them — pre-filled zeroes, not blanks, which is the case the
   scrape has to get right. */
const TERMS_FIELDS = {
  loanAmount: "$1,300,000",
  totalLoanValue: "$3,260,267",
  LTV: "39.87%",
  LoanTerm: "24",
  RateMonthStart1: "1",
  RateMonthEnd1: "12",
  InterestRate1: "7.90%",
  RateMonthStart2: "13",
  RateMonthEnd2: "24",
  InterestRate2: "8.40%",
  OriginationFeePoints: "2.0000",
  BrokerFeePoints: "2.0000",
  txtEvaluation: "$1,750.00",
  txtLoanTermsNotes: "",
  JuniorFinancingAmount: "",
  SecondTDRate: "0.00%",
  SecondTDFeePoints: "",
  SecondTDFeeAmount: "",
  CombinedLoanAmount_LTV: "$1,300,000.00  /  0",
  BlendedRate: "7.90%",
  BlendedFeePoints: "2.0000",
  BlendedFeeAmount: "$26,000.00",
  SellerFinancingAmount: "",
  InitialDisbursed: "",
  DrawMinimumAmount: "",
  DrawIncrementAmount: "",
  interestReserveAmount: "",
  interestReserveMonths: "",
  txtpartialReconveyance: ""
};

/** The same page with some fields overridden; `null` removes the element. */
const withFields = (over = {}) => {
  const fields = { ...TERMS_FIELDS, ...over };
  for (const [id, value] of Object.entries(fields)) if (value === null) delete fields[id];
  return fields;
};

/* ── The contact and property grids (#197) ───────────────

   These two are NOT in the page's HTML: Humperdink fetches them after render
   and paints them into jqxGrids. Each grid is a header row of column headers
   and a body of rows whose cells sit in the same column order, so the headers
   below are the contract — the scrape finds its columns by matching this text,
   never by counting positions.

   Both header lists and the row values are copied from a saved copy of a real
   loan details page, double space in `Purchase  Price` and all. */
const CONTACT_HEADERS = ["", "", "Type", "Name", "Company", "Email", "Primary Phone", "Alternate Phone", "Notes"];
const CONTACT_ROWS = [
  ["", "", "Broker", "Dan LuVisi", "Market Capital Group", "dluvisi@mcglend.com", "(310) 265-4492", "", ""],
  ["", "", "Borrower", "Duda Adams", "", "", "", "", ""],
  ["", "", "Escrow", "Somebody At Escrow", "First American", "", "", "", ""]
];

const PROPERTY_HEADERS = [
  "",
  "Parcel",
  "Address",
  "Transaction",
  "Property",
  "Purchase  Price",
  "Purchase Date",
  "Existing Debt",
  "Final Value",
  "Loan Amount"
];
/* Humperdink packs the whole address into one `<br/>`-split cell; the scrape
   wants the street line only. The saved loan refinances its one property. */
const HARBOR_ADDRESS = "217 to 225 S. Harbor Boulevard,  <br>Santa Ana,  CA 92704, Orange";
const PROPERTY_ROWS = [
  ["", "1", HARBOR_ADDRESS, "Refinance-Standard", "Apartment", "$0", "", "$0", "$3,260,267", "$1,300,000"]
];

/** A page whose grids and rows can be swapped out per test. */
const withGrids = (over = {}) => ({
  contactHeaders: CONTACT_HEADERS,
  contactRows: CONTACT_ROWS,
  propertyHeaders: PROPERTY_HEADERS,
  propertyRows: PROPERTY_ROWS,
  ...over
});

/* ── A DOM small enough to read, big enough for the script ──

   The userscript touches exactly this much of the page: the title, the address
   bar, one button it creates and appends, and the clipboard. Anything it starts
   reaching for beyond this (a selector into Humperdink's markup, say) fails
   here loudly, which is the point. */
const runUserscript = ({
  title,
  href,
  clipboard = "ok",
  fields = TERMS_FIELDS,
  grids = withGrids(),
  /* Every test states the id it wants, so this default is only the "nobody has
     told it where Hot Task is" case — the pre-#198 copy-and-tell behaviour. It
     is deliberately NOT the shipped value: the two tests that care about what
     the file ships with read it out of the file. */
  appId = "",
  /* "blocked" makes window.open return null, the way a popup blocker does. */
  popups = "ok",
  /* Divides every timer the script sets, so a test can run the control's
     twenty-second wait-for-the-grids ceiling in a fraction of a second. */
  clockScale = 1
}) => {
  const url = new URL(href);
  const copied = [];
  const created = [];
  let mountedButton = null;
  let buttonsMounted = 0;
  let page = grids;

  /* One grid cell. `textContent` strips the markup the way a browser would;
     `innerHTML` keeps the `<br/>` the address scrape splits on. */
  const gridCell = (html) => ({
    role: "gridcell",
    innerHTML: html,
    textContent: String(html).replace(/<[^>]*>/g, " ")
  });

  /* The two jqxGrid tables the script reads, rebuilt from `page` on every
     lookup — so a test can hand the grids over mid-run and model Humperdink's
     background fetch landing late. A grid list of `null` is the grid element
     itself being gone; `[]` is the grid painted but still empty. */
  const gridElement = (role, rowsOrHeaders) => {
    if (rowsOrHeaders === null) return null;
    const children =
      role === "columnheader"
        ? rowsOrHeaders.map((text) => ({ role, textContent: text }))
        : rowsOrHeaders.map((cells) => ({
            role,
            cells: cells.map(gridCell),
            querySelectorAll(selector) {
              return selector.includes("gridcell") ? this.cells : [];
            }
          }));
    return {
      querySelectorAll(selector) {
        return selector.includes(role) ? children : [];
      }
    };
  };

  const GRID_ELEMENTS = {
    columntableContactsGrid: () => gridElement("columnheader", page.contactHeaders),
    contenttableContactsGrid: () => gridElement("row", page.contactRows),
    columntablePropertiesGrid: () => gridElement("columnheader", page.propertyHeaders),
    contenttablePropertiesGrid: () => gridElement("row", page.propertyRows)
  };

  const createElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      type: "",
      textContent: "",
      value: "",
      mounted: false,
      style: { cssText: "" },
      attributes: {},
      listeners: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(event, fn) {
        (this.listeners[event] ??= []).push(fn);
      },
      select() {},
      click() {
        for (const fn of this.listeners.click ?? []) fn();
      }
    };
    created.push(el);
    return el;
  };

  const document = {
    title,
    createElement,
    /* The script's own control first, then the page's terms fields and its two
       grids. An id the page doesn't carry returns null, which is what a
       Humperdink release that renamed something looks like from in here. */
    getElementById: (id) =>
      created.find((el) => el.mounted && el.id === id) ??
      (Object.prototype.hasOwnProperty.call(fields, id) ? { id, value: fields[id] } : null) ??
      (Object.prototype.hasOwnProperty.call(GRID_ELEMENTS, id) ? GRID_ELEMENTS[id]() : null),
    body: {
      appendChild(el) {
        el.mounted = true;
        if (el.tagName === "BUTTON") {
          mountedButton = el;
          buttonsMounted += 1;
        }
      },
      removeChild(el) {
        el.mounted = false;
      }
    },
    execCommand(command) {
      if (command !== "copy") return false;
      if (clipboard === "dead") return false;
      const scratch = created.find((el) => el.tagName === "TEXTAREA" && el.mounted);
      if (!scratch) return false;
      copied.push(scratch.value);
      return true;
    }
  };

  const navigator =
    clipboard === "no-async-api"
      ? {}
      : {
          clipboard: {
            writeText(text) {
              if (clipboard === "dead") return Promise.reject(new Error("denied"));
              copied.push(text);
              return Promise.resolve();
            }
          }
        };

  /* The control resets its own label on a timer. Unref it, or every test here
     holds the process open for the full six seconds. */
  const unrefed = (fn, ms) => {
    const handle = setTimeout(fn, ms / clockScale);
    handle.unref?.();
    return handle;
  };

  /* Every tab the control asks the browser to open (#198). A blocked popup is
     recorded too — the control has to notice the refusal, not just the ask. */
  const opened = [];
  const openedWindows = [];
  const open = (href, target, features) => {
    opened.push({ href, target, features });
    if (popups === "blocked") return null;
    /* A real `window.open` handle carries an `opener` back to this page. The
       control nulls it; the test watches that it does. */
    const handle = { href, opener: { href: url.href } };
    openedWindows.push(handle);
    return handle;
  };

  const source = userscriptWithAppId(appId);
  const sandbox = { document, location: url, navigator, open, setTimeout: unrefed, clearTimeout, console, URL };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    copied,
    opened,
    openedWindows,
    button: mountedButton,
    get buttonsMounted() {
      return buttonsMounted;
    },
    /* Tampermonkey can run the script again on a soft navigation. */
    remount() {
      vm.runInContext(source, sandbox);
    },
    /* Humperdink's background fetch landing, after the script already mounted. */
    loadGrids(next) {
      page = { ...page, ...next };
    },
    /* Let the click handler's clipboard promise settle before we read the label. */
    async press() {
      mountedButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
};

/* ── The control on the Humperdink page ─────────────────── */

test("the script mounts a Send to Hot Task control on a loan details page", () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  assert.ok(page.button, "a button was appended to the page");
  assert.equal(page.button.textContent, "Send to Hot Task");
});

test("running the script again leaves one control", () => {
  // Two stacked buttons on top of each other is a support call nobody can
  // describe, so the script bails when its own control is already mounted.
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  page.remount();
  assert.equal(page.buttonsMounted, 1);
});

test("pressing it copies a versioned payload with the loan name and the page URL", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.press();
  assert.equal(page.copied.length, 1);
  const payload = JSON.parse(page.copied[0]);
  assert.equal(payload.kind, HUMPERDINK_PAYLOAD_KIND);
  assert.equal(payload.version, HUMPERDINK_PAYLOAD_VERSION);
  assert.equal(payload.loanName, "Adams - Harbor");
  assert.equal(payload.loanUrl, LOAN_URL);
  assert.equal(page.button.textContent, "Copied — paste it into Hot Task");
});

test("the copied URL drops query and hash, so one loan is one key", async () => {
  // ADR-0001 makes the link the canonical key for a Loan. A visit carrying a
  // stray param would otherwise mint a second loan for the same page.
  const page = runUserscript({ title: "Adams - Harbor - Details", href: `${LOAN_URL}?tab=terms#notes` });
  await page.press();
  assert.equal(JSON.parse(page.copied[0]).loanUrl, LOAN_URL);
});

/* AC: "when an expected element is missing, the control says so rather than
   copying a partial payload silently". The loan name lives only in the page
   title, so a title that isn't a loan title is exactly that case. */
test("a page title it can't read reports the problem and copies nothing", async () => {
  const page = runUserscript({ title: "Loan Pipeline", href: LOAN_URL });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /Couldn't read the loan name/);
});

test("an empty page title reports the problem and copies nothing", async () => {
  const page = runUserscript({ title: "", href: LOAN_URL });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /Couldn't read/);
});

test("a page that isn't a loan details page reports the problem and copies nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: "https://humperdink.loneoakfund.com/Loans/Index"
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /loan details URL/);
});

test("a lookalike path on some other site is not a loan page either", async () => {
  // The @match line should never let this run here at all, but the control
  // makes its own decision rather than trusting the match.
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: "https://evil.example/x/Loans/Details/335203"
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /loan details URL/);
});

test("a browser with no async clipboard API falls back to execCommand", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, clipboard: "no-async-api" });
  await page.press();
  assert.equal(parseHumperdinkPayload(page.copied[0]).ok, true);
  assert.equal(page.button.textContent, "Copied — paste it into Hot Task");
});

test("a refused clipboard says so instead of claiming a copy", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, clipboard: "dead" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /Couldn't reach the clipboard/);
});

/* ── The round trip: what the script writes, the app reads ── */

test("what the userscript copies is what the create form parses", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.press();
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true);
  assert.equal(result.payload.loanName, "Adams - Harbor");
  assert.equal(result.payload.loanUrl, LOAN_URL);
});

test("the userscript's version is one the app supports", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.press();
  assert.ok(JSON.parse(page.copied[0]).version <= SUPPORTED_HUMPERDINK_PAYLOAD_VERSION);
});

test("a loan name with its own hyphens survives the round trip", async () => {
  const page = runUserscript({ title: "Smith - 1042 - Rev 3 - Details", href: LOAN_URL });
  await page.press();
  assert.equal(parseHumperdinkPayload(page.copied[0]).payload.loanName, "Smith - 1042 - Rev 3");
});

/* ── Reading the title ──────────────────────────────────── */

test("loanNameFromPageTitle strips the Details suffix", () => {
  assert.equal(loanNameFromPageTitle("Adams - Harbor - Details"), "Adams - Harbor");
  assert.equal(loanNameFromPageTitle("  Adams - Harbor - Details  "), "Adams - Harbor");
});

test("loanNameFromPageTitle returns nothing for a title that isn't a loan's", () => {
  assert.equal(loanNameFromPageTitle("Loan Pipeline"), "");
  assert.equal(loanNameFromPageTitle(" - Details"), "");
  assert.equal(loanNameFromPageTitle(""), "");
  assert.equal(loanNameFromPageTitle(null), "");
  assert.equal(loanNameFromPageTitle(undefined), "");
});

/* ── Parsing a paste ────────────────────────────────────── */

const payloadText = (over = {}) =>
  JSON.stringify({
    kind: HUMPERDINK_PAYLOAD_KIND,
    version: HUMPERDINK_PAYLOAD_VERSION,
    loanName: "Adams - Harbor",
    loanUrl: LOAN_URL,
    ...over
  });

test("a good payload parses", () => {
  const result = parseHumperdinkPayload(payloadText());
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    kind: HUMPERDINK_PAYLOAD_KIND,
    version: 1,
    loanName: "Adams - Harbor",
    loanUrl: LOAN_URL
  });
});

test("surrounding whitespace from the paste is tolerated", () => {
  assert.equal(parseHumperdinkPayload(`\n  ${payloadText()}\n`).ok, true);
});

test("an empty paste says there is nothing to import", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const result = parseHumperdinkPayload(empty);
    assert.equal(result.ok, false);
    assert.match(result.error, /Nothing to import/);
  }
});

test("text that isn't a payload says where to get one", () => {
  for (const junk of ["hello", "{not json", "[1,2,3]", '"a string"', "42", "null"]) {
    const result = parseHumperdinkPayload(junk);
    assert.equal(result.ok, false, `${junk} should not parse`);
    assert.match(result.error, /Send to Hot Task/);
  }
});

test("JSON from something else entirely is not mistaken for ours", () => {
  const result = parseHumperdinkPayload(JSON.stringify({ loanName: "Adams", loanUrl: LOAN_URL }));
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't a Humperdink payload/);
});

test("a payload missing the name or the link is rejected whole, not half-read", () => {
  for (const broken of [{ loanName: "" }, { loanName: "   " }, { loanUrl: "" }, { loanName: 7 }, { loanUrl: null }]) {
    const result = parseHumperdinkPayload(payloadText(broken));
    assert.equal(result.ok, false, `${JSON.stringify(broken)} should be rejected`);
    assert.match(result.error, /missing the loan name or its link/);
  }
});

test("a link that isn't a loan details page is rejected", () => {
  const result = parseHumperdinkPayload(payloadText({ loanUrl: "https://humperdink.loneoakfund.com/Loans/Index" }));
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't a Humperdink loan page/);
});

/* The link doesn't stop at the form: it becomes the canonical key for a Loan
   (ADR-0001) and is rendered as an `href` on every card for that loan. A pasted
   payload is attacker-supplied text — the human copied it off a page we don't
   control — so the check has to hold here rather than at the anchor. */
test("only an http(s) URL whose whole path is a loan details path counts as one", () => {
  const notLoanPages = [
    "javascript:alert(1)//Loans/Details/1",
    "data:text/html,/Loans/Details/1",
    "https://evil.example/redirect?to=/Loans/Details/1",
    "https://evil.example/x/Loans/Details/1",
    "/Loans/Details/335203",
    "Loans/Details/335203",
    "",
    "   "
  ];
  for (const url of notLoanPages) assert.equal(isLoanDetailsUrl(url), false, `${url} is not a loan page`);

  const loanPages = [
    "https://humperdink.loneoakfund.com/Loans/Details/335203",
    "https://humperdink.loneoakfund.com/Loans/Details/335203/",
    "http://humperdink.local/loans/details/335203"
  ];
  for (const url of loanPages) assert.equal(isLoanDetailsUrl(url), true, `${url} is a loan page`);
});

test("a payload carrying a javascript: link is rejected, not filled into the form", () => {
  const result = parseHumperdinkPayload(payloadText({ loanUrl: "javascript:alert(1)//Loans/Details/1" }));
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't a Humperdink loan page/);
});

/* The versioning rules in humperdink.ts, exercised. Userscripts are
   self-installed, so the script in the field and the deployed app are always
   different ages — in both directions. */
test("a payload from a newer script than this app understands says to update", () => {
  const result = parseHumperdinkPayload(payloadText({ version: SUPPORTED_HUMPERDINK_PAYLOAD_VERSION + 1 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /newer Send to Hot Task script/);
  assert.match(result.error, /needs updating/);
});

/* A payload carrying our `kind` is ours whatever else is wrong with it, so it
   must never be answered with "press Send to Hot Task, then paste here" — the
   filer already did that, and doing it again fixes nothing. */
test("a missing or nonsense version is rejected as a bad payload, not as a stray paste", () => {
  for (const version of [undefined, 0, -1, "1", null, Number.NaN]) {
    const result = parseHumperdinkPayload(payloadText({ version }));
    assert.equal(result.ok, false, `version ${String(version)}`);
    assert.match(result.error, /doesn't say which version it is/);
    assert.doesNotMatch(result.error, /isn't a Humperdink payload/);
  }
});

test("no message about our own payload tells the filer to go and re-press the button", () => {
  const ours = [
    payloadText({ version: 99 }),
    payloadText({ version: undefined }),
    payloadText({ loanName: "" }),
    payloadText({ loanUrl: "https://humperdink.loneoakfund.com/Loans/Index" })
  ];
  for (const text of ours) {
    const result = parseHumperdinkPayload(text);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /isn't a Humperdink payload/, text);
  }
});

/* Additive fields keep the version (#196 and #197 extend the payload this way),
   so an older app must read the parts it knows and drop the rest rather than
   choking on them. */
test("unknown fields at a supported version are ignored, not fatal", () => {
  const result = parseHumperdinkPayload(payloadText({ contacts: [], underwriter: "someone" }));
  assert.equal(result.ok, true);
  assert.equal(result.payload.loanName, "Adams - Harbor");
  assert.equal("contacts" in result.payload, false, "the parser hands back only what it declares");
  assert.equal("underwriter" in result.payload, false);
});

/* ── The loan terms (#196) ──────────────────────────────────

   The terms are the first thing scraped by element id, so these tests run the
   real userscript against the ids the real page carries. A Humperdink release
   that renames one of them turns up here as a red test, not as a note with a
   quiet hole in it. */

const scrapeTerms = async (fields) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, fields });
  await page.press();
  assert.equal(page.copied.length, 1, page.button.textContent);
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true, result.error);
  return result.payload.terms ?? {};
};

const scrapeNote = async (fields, grids = withGrids()) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, fields, grids });
  await page.press();
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true, result.error);
  return humperdinkNoteText(result.payload);
};

test("the core terms travel, read by element id", async () => {
  const terms = await scrapeTerms(TERMS_FIELDS);
  assert.equal(terms.loanAmount, "$1,300,000");
  assert.equal(terms.totalValue, "$3,260,267");
  assert.equal(terms.ltv, "39.87%");
  assert.equal(terms.termMonths, "24");
  assert.equal(terms.originationFeePoints, "2.0000");
  assert.equal(terms.brokerFeePoints, "2.0000");
  assert.equal(terms.evaluationFee, "$1,750.00");
});

test("both interest rate tiers travel, in order", async () => {
  const terms = await scrapeTerms(TERMS_FIELDS);
  assert.deepEqual(terms.rateTiers, [
    { startMonth: "1", endMonth: "12", rate: "7.90%" },
    { startMonth: "13", endMonth: "24", rate: "8.40%" }
  ]);
});

test("a loan with one rate tier carries one, not an empty second", async () => {
  const terms = await scrapeTerms(withFields({ RateMonthStart2: null, RateMonthEnd2: null, InterestRate2: null }));
  assert.deepEqual(terms.rateTiers, [{ startMonth: "1", endMonth: "12", rate: "7.90%" }]);
});

test("a stepped loan carries every tier the table holds", async () => {
  const terms = await scrapeTerms(
    withFields({ RateMonthStart3: "25", RateMonthEnd3: "36", InterestRate3: "9.10%" })
  );
  assert.equal(terms.rateTiers.length, 3);
  assert.deepEqual(terms.rateTiers[2], { startMonth: "25", endMonth: "36", rate: "9.10%" });
});

test("Loan Term Notes travel when the desk has typed some", async () => {
  const terms = await scrapeTerms(withFields({ txtLoanTermsNotes: "Rate locked 14 days.\nExtension at 1 point." }));
  assert.equal(terms.loanTermNotes, "Rate locked 14 days.\nExtension at 1 point.");
});

/* AC: "Conditional terms appear only when they hold a value; a loan with none
   produces no empty sections." The saved page IS such a loan — its junior,
   seller, disbursement, reserve and reconveyance panels all sit unused. */
test("a loan using none of the conditional panels carries none of them", async () => {
  const terms = await scrapeTerms(TERMS_FIELDS);
  for (const absent of [
    "juniorFinancingAmount",
    "juniorFinancingRate",
    "juniorFinancingPoints",
    "juniorFinancingFee",
    "combinedLoanAndCltv",
    "blendedRate",
    "blendedPoints",
    "blendedFee",
    "sellerFinancingAmount",
    "initialAdvance",
    "drawMinimum",
    "drawIncrement",
    "interestReserveAmount",
    "interestReserveMonths",
    "partialReconveyance"
  ]) {
    assert.equal(absent in terms, false, `${absent} should not travel on a loan that doesn't use it`);
  }
});

/* The whole note the saved loan produces: core terms, its two contacts, and no
   property block because its one property is a refinance. */
test("its note is the core terms and its people, and nothing else", async () => {
  const note = await scrapeNote(TERMS_FIELDS);
  assert.equal(
    note,
    [
      "Loan Terms",
      "Loan Amount: $1,300,000",
      "Total Value: $3,260,267",
      "LTV: 39.87%",
      "Term: 24 months",
      "Interest Rate: Months 1–12 at 7.90%",
      "Interest Rate: Months 13–24 at 8.40%",
      "Origination Fee: 2.0000 points",
      "Broker Fee: 2.0000 points",
      "Evaluation Fee: $1,750.00",
      "",
      "Contacts",
      "Broker: Dan LuVisi",
      "Borrower: Duda Adams"
    ].join("\n")
  );
});

/* Humperdink pre-fills its unused CONDITIONAL panels with zeroes rather than
   blanks, so "is it empty" is not the test there — `Rate: 0.00%` under a Junior
   Financing heading is exactly the empty label #196 rules out. */
test("a zero in an unused panel is not a value", async () => {
  const terms = await scrapeTerms(
    withFields({ SecondTDRate: "0.00%", SellerFinancingAmount: "$0.00", interestReserveMonths: "0" })
  );
  assert.equal("juniorFinancingRate" in terms, false);
  assert.equal("sellerFinancingAmount" in terms, false);
  assert.equal("interestReserveMonths" in terms, false);
});

test("junior financing travels when the loan has some, and brings the blended figures", async () => {
  const terms = await scrapeTerms(
    withFields({ JuniorFinancingAmount: "$200,000.00", SecondTDRate: "10.00%", SecondTDFeePoints: "1.0000" })
  );
  assert.equal(terms.juniorFinancingAmount, "$200,000.00");
  assert.equal(terms.juniorFinancingRate, "10.00%");
  assert.equal(terms.juniorFinancingPoints, "1.0000");
  assert.equal(terms.combinedLoanAndCltv, "$1,300,000.00  /  0");
  assert.equal(terms.blendedRate, "7.90%");
  assert.equal(terms.blendedPoints, "2.0000");
  assert.equal(terms.blendedFee, "$26,000.00");
});

/* The blended figures are computed and are filled on every page, so without
   this gate every note would restate the core terms under a second heading. */
test("the blended figures stay behind when there is no junior loan", async () => {
  const note = await scrapeNote(TERMS_FIELDS);
  assert.doesNotMatch(note, /Blended/);
  assert.doesNotMatch(note, /Junior Financing/);
});

test("the other conditional panels travel when they hold values", async () => {
  const terms = await scrapeTerms(
    withFields({
      SellerFinancingAmount: "$50,000.00",
      InitialDisbursed: "$900,000.00",
      DrawMinimumAmount: "$25,000.00",
      DrawIncrementAmount: "$5,000.00",
      interestReserveAmount: "$40,000.00",
      interestReserveMonths: "6",
      txtpartialReconveyance: "Release lot 4 at $300k paydown."
    })
  );
  assert.equal(terms.sellerFinancingAmount, "$50,000.00");
  assert.equal(terms.initialAdvance, "$900,000.00");
  assert.equal(terms.drawMinimum, "$25,000.00");
  assert.equal(terms.drawIncrement, "$5,000.00");
  assert.equal(terms.interestReserveAmount, "$40,000.00");
  assert.equal(terms.interestReserveMonths, "6");
  assert.equal(terms.partialReconveyance, "Release lot 4 at $300k paydown.");
});

/* AC: "Terms render into the notes field as readable plain text, no markdown
   syntax." The notes field is a text node with whitespace preserved and no
   markdown parsing, so a `**` or a `|` would come out literal. */
test("a fully-loaded loan renders every section in a stable order", async () => {
  const note = await scrapeNote(
    withFields({
      txtLoanTermsNotes: "Rate locked 14 days.",
      JuniorFinancingAmount: "$200,000.00",
      SecondTDRate: "10.00%",
      SellerFinancingAmount: "$50,000.00",
      InitialDisbursed: "$900,000.00",
      interestReserveAmount: "$40,000.00",
      interestReserveMonths: "6",
      txtpartialReconveyance: "Release lot 4 at $300k paydown."
    })
  );
  assert.deepEqual(
    note.split("\n\n").map((block) => block.split("\n")[0]),
    [
      "Loan Terms",
      "Loan Term Notes",
      "Junior Financing",
      "Blended Totals",
      "Seller Financing",
      "Disbursement Options",
      "Interest Reserve",
      "Partial Reconveyance",
      "Contacts"
    ]
  );
  assert.doesNotMatch(note, /[*_#|`]/, "no markdown syntax — the field renders it literally");
});

test("the note is empty when the payload carries no terms at all", () => {
  const result = parseHumperdinkPayload(payloadText());
  assert.equal(humperdinkNoteText(result.payload), "");
  assert.deepEqual(humperdinkNoteSections(result.payload), []);
});

/* AC: "A loan page missing an expected terms field reports it rather than
   importing a silent gap." A missing ELEMENT means Humperdink moved something;
   an empty one just means this loan doesn't use it. */
test("a page missing a core terms element reports it and copies nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    fields: withFields({ LTV: null, txtEvaluation: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /loan terms/);
  assert.match(page.button.textContent, /LTV/);
  assert.match(page.button.textContent, /txtEvaluation/);
});

test("a page missing the first interest rate row reports it too", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    fields: withFields({ InterestRate1: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /InterestRate1/);
});

test("a core field that is merely empty is not reported, it just doesn't travel", async () => {
  // The saved page's Loan Term Notes box is empty, and that is an ordinary loan.
  const terms = await scrapeTerms(withFields({ txtLoanTermsNotes: "" }));
  assert.equal("loanTermNotes" in terms, false);
});

/* AC: "Excluded fields listed above do not appear in the note." The payload
   type has no home for them, so this is really a test that nobody added one. */
test("the excluded fields never reach the note", async () => {
  const note = await scrapeNote(
    withFields({
      LoanAmountRequested: "$1,500,000",
      TermRequested: "36",
      txtReasonForLoan: "Refinance",
      txtExitStrategy: "Sale",
      txtBorrowerExperience: "12 deals",
      txtRedFlags: "None",
      comboLender: "Lone Oak",
      comboStatus: "Approved",
      comboClosingDate: "2026-01-15"
    })
  );
  for (const excluded of ["$1,500,000", "Refinance", "Sale", "12 deals", "Lone Oak", "Approved", "2026-01-15"]) {
    assert.doesNotMatch(note, new RegExp(excluded.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&")), `${excluded} is excluded`);
  }
});

/* AC: "Ticket #194's name-and-link behaviour still works unchanged." */
test("the name and the link still cross with the terms alongside them", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.press();
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.payload.loanName, "Adams - Harbor");
  assert.equal(result.payload.loanUrl, LOAN_URL);
});

/* ── What the parser will accept as terms ───────────────── */

const withTerms = (terms) => parseHumperdinkPayload(payloadText({ terms }));

test("junk in the terms field costs the import nothing", () => {
  for (const junk of ["a string", 42, null, [], {}]) {
    const result = withTerms(junk);
    assert.equal(result.ok, true, `terms ${JSON.stringify(junk)}`);
    assert.equal(result.payload.loanName, "Adams - Harbor");
    assert.equal("terms" in result.payload, false);
  }
});

test("non-string and empty term values are dropped, not stringified", () => {
  const result = withTerms({ loanAmount: 500000, ltv: "  ", totalValue: "$1", termMonths: null });
  assert.deepEqual(result.payload.terms, { totalValue: "$1" });
});

test("a term long enough to swamp the note is capped", () => {
  const result = withTerms({ loanAmount: "$".repeat(5000), loanTermNotes: "n".repeat(5000) });
  assert.equal(result.payload.terms.loanAmount.length, 300);
  assert.equal(result.payload.terms.loanTermNotes.length, 1000, "the prose fields get Humperdink's own maxlength");
});

test("rate tiers are rebuilt row by row, and a runaway table is capped", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ startMonth: String(i + 1), endMonth: "x", rate: "1%" }));
  const result = withTerms({ rateTiers: [...rows, "not a row", null] });
  assert.equal(result.payload.terms.rateTiers.length, 12);
  assert.deepEqual(result.payload.terms.rateTiers[0], { startMonth: "1", endMonth: "x", rate: "1%" });
});

test("an all-empty rate row is dropped rather than rendered as a bare heading", () => {
  const result = withTerms({ loanAmount: "$1", rateTiers: [{ startMonth: "", endMonth: "", rate: "" }] });
  assert.equal("rateTiers" in result.payload.terms, false);
});

test("a rate row with no rate still says which months it covers", () => {
  const result = withTerms({ rateTiers: [{ startMonth: "1", endMonth: "12", rate: "" }] });
  assert.equal(humperdinkNoteText(result.payload), "Loan Terms\nInterest Rate: Months 1–12");
});

/* A zero in the CORE set is a loan term, not an unused panel. A loan with no
   broker really does have a broker fee of zero, and the note has to say so —
   dropping the line leaves the reader unable to tell it from a field the script
   failed to read. */
test("a zero in the core terms is a real term and says so", async () => {
  const note = await scrapeNote(withFields({ BrokerFeePoints: "0.0000", txtEvaluation: "$0.00" }));
  assert.match(note, /Broker Fee: 0\.0000 points/);
  assert.match(note, /Evaluation Fee: \$0\.00/);
});

/* #196 lists the combined/blended figures as their own conditional group, and
   they only mean anything next to a junior loan. */
test("the blended figures read as their own block under the junior loan", async () => {
  const note = await scrapeNote(withFields({ JuniorFinancingAmount: "$200,000.00", SecondTDRate: "10.00%" }));
  const headings = note.split("\n\n").map((block) => block.split("\n")[0]);
  assert.deepEqual(headings, ["Loan Terms", "Junior Financing", "Blended Totals", "Contacts"]);
});

/* ── The people and the properties (#197) ───────────────────

   These two come off Humperdink's jqxGrids, which the page fetches AFTER it
   renders. Everything below matches on header text and contact type text —
   Humperdink's row ids are positional (`row0ContactsGrid`), so anything built
   on them points at the wrong person the first time somebody adds a contact. */

const acquisitionRow = (over = {}) => {
  const row = [...PROPERTY_ROWS[0]];
  row[2] = over.address ?? "1400 Ocean Avenue,  <br>Long Beach,  CA 90802, Los Angeles";
  row[3] = over.transaction ?? "Acquisition";
  row[5] = over.price ?? "$850,000";
  return row;
};

/** Long enough for the control's grid poll to have ticked a few times. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

const scrapePayload = async (over = {}) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, ...over });
  await page.press();
  assert.equal(page.copied.length, 1, page.button.textContent);
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true, result.error);
  return result.payload;
};

test("the broker and the borrower travel, matched on contact type", async () => {
  const payload = await scrapePayload();
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" }
  ]);
});

/* The contact grid's rows are in whatever order Humperdink returns them and its
   row ids are positional. Reordering the grid must not reorder the note or —
   far worse — hand the borrower's name to the broker's label. */
test("shuffling the contact rows changes nothing about the note", async () => {
  const shuffled = [CONTACT_ROWS[2], CONTACT_ROWS[1], CONTACT_ROWS[0]];
  const payload = await scrapePayload({ grids: withGrids({ contactRows: shuffled }) });
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" }
  ]);
});

/* The same for the columns: Humperdink can reorder or insert one, and the
   scrape finds `Type` and `Name` by their header text. */
test("an inserted column doesn't shift the scrape onto the wrong cell", async () => {
  const headers = ["Rating", ...CONTACT_HEADERS];
  const rows = CONTACT_ROWS.map((row) => ["A+", ...row]);
  const payload = await scrapePayload({ grids: withGrids({ contactHeaders: headers, contactRows: rows }) });
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" }
  ]);
});

test("the loan's other contacts stay in Humperdink", async () => {
  const note = await scrapeNote(TERMS_FIELDS);
  assert.doesNotMatch(note, /Escrow/);
  assert.doesNotMatch(note, /Somebody At Escrow/);
});

test("a loan with two borrowers carries both, under the borrower label", async () => {
  const rows = [...CONTACT_ROWS, ["", "", "Borrower", "Marta Adams", "", "", "", "", ""]];
  const payload = await scrapePayload({ grids: withGrids({ contactRows: rows }) });
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" },
    { type: "Borrower", name: "Marta Adams" }
  ]);
});

test("a loan with no broker just carries the borrower", async () => {
  const rows = CONTACT_ROWS.filter((row) => row[2] !== "Broker");
  const payload = await scrapePayload({ grids: withGrids({ contactRows: rows }) });
  assert.deepEqual(payload.contacts, [{ type: "Borrower", name: "Duda Adams" }]);
});

/* AC: "A loan with no acquisitions produces no property section." The saved
   loan refinances its one property. */
test("a refinanced property contributes nothing", async () => {
  const payload = await scrapePayload();
  assert.equal("properties" in payload, false);
  assert.doesNotMatch(humperdinkNoteText(payload), /Properties Acquired/);
  assert.doesNotMatch(humperdinkNoteText(payload), /Harbor Boulevard/);
});

/* AC: "only their street address and purchase price". Humperdink packs the
   whole address into one `<br/>`-split cell. */
test("an acquired property carries its street address and its purchase price", async () => {
  const payload = await scrapePayload({ grids: withGrids({ propertyRows: [acquisitionRow()] }) });
  assert.deepEqual(payload.properties, [
    { address: "1400 Ocean Avenue", purchasePrice: "$850,000" }
  ]);
});

test("nothing else off the property row travels", async () => {
  const note = await scrapeNote(TERMS_FIELDS, withGrids({ propertyRows: [acquisitionRow()] }));
  assert.equal(note.split("\n\n").pop(), "Properties Acquired\n1400 Ocean Avenue — $850,000");
  for (const excluded of ["Apartment", "Long Beach", "90802", "Los Angeles"]) {
    assert.doesNotMatch(note, new RegExp(excluded), `${excluded} is not what an LOI check needs`);
  }
});

test("an acquisition of any kind counts", async () => {
  for (const transaction of ["Acquisition", "Acquisition with Refi Cross", "Purchase-Standard"]) {
    const payload = await scrapePayload({
      grids: withGrids({ propertyRows: [acquisitionRow({ transaction })] })
    });
    assert.equal(payload.properties.length, 1, transaction);
  }
});

/* AC: "A loan where the loan-level scenario and the per-property transaction
   disagree follows the per-property signal." One loan can buy some properties
   and refinance others, so `comboLoanScenarioType` is never consulted — this
   asserts that by contradicting it in both directions. */
test("the per-property transaction wins over the loan-level scenario type", async () => {
  const bought = await scrapePayload({
    fields: withFields({ comboLoanScenarioType: "Refinance" }),
    grids: withGrids({ propertyRows: [acquisitionRow()] })
  });
  assert.deepEqual(bought.properties, [{ address: "1400 Ocean Avenue", purchasePrice: "$850,000" }]);

  const refinanced = await scrapePayload({ fields: withFields({ comboLoanScenarioType: "Acquisition" }) });
  assert.equal("properties" in refinanced, false);
});

test("a mixed loan carries only the properties it is buying", async () => {
  const payload = await scrapePayload({
    grids: withGrids({
      propertyRows: [
        PROPERTY_ROWS[0],
        acquisitionRow(),
        acquisitionRow({ address: "88 Palm Court, <br>Irvine, CA 92602", price: "$1,200,000" })
      ]
    })
  });
  assert.deepEqual(payload.properties, [
    { address: "1400 Ocean Avenue", purchasePrice: "$850,000" },
    { address: "88 Palm Court", purchasePrice: "$1,200,000" }
  ]);
});

test("an acquisition with no purchase price filled in carries the address alone", async () => {
  const payload = await scrapePayload({
    grids: withGrids({ propertyRows: [acquisitionRow({ price: "$0" })] })
  });
  assert.deepEqual(payload.properties, [{ address: "1400 Ocean Avenue" }]);
  assert.match(humperdinkNoteText(payload), /Properties Acquired\n1400 Ocean Avenue$/);
});

/* AC: "Note sections read in a stable order alongside the terms from #196." */
test("the people and the properties read after the terms, always in that order", async () => {
  const note = await scrapeNote(
    withFields({ txtLoanTermsNotes: "Rate locked 14 days." }),
    withGrids({ propertyRows: [acquisitionRow()] })
  );
  assert.deepEqual(
    note.split("\n\n").map((block) => block.split("\n")[0]),
    ["Loan Terms", "Loan Term Notes", "Contacts", "Properties Acquired"]
  );
  assert.doesNotMatch(note, /[*_#|`]/, "no markdown syntax — the field renders it literally");
});

/* AC: "The control shows `Loading` until both background loads have arrived,
   then completes." */
test("the control reads Loading until both grids have painted", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ contactRows: [], propertyRows: [] })
  });
  assert.equal(page.button.textContent, "Loading…");

  // Pressing while it waits copies nothing and says why.
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /Still loading/);

  page.loadGrids({ contactRows: CONTACT_ROWS, propertyRows: PROPERTY_ROWS });
  await settle();
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(parseHumperdinkPayload(page.copied[0]).ok, true);
});

test("one grid arriving is not both", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ contactRows: [], propertyRows: [] })
  });
  page.loadGrids({ contactRows: CONTACT_ROWS });
  await settle();
  assert.equal(page.button.textContent, "Loading…");
});

test("a page whose grids are already painted never says Loading", () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  assert.equal(page.button.textContent, "Send to Hot Task");
});

/* AC: "Missing contacts or properties are reported, not silently omitted." */
test("a grid whose element is gone is reported and nothing is copied", async () => {
  // A missing grid and a slow one look the same from in here, so the control
  // waits for it like any other and names it once it has given up.
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ contactRows: null }),
    clockScale: 200
  });
  assert.equal(page.button.textContent, "Loading…");
  await settle();
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /contenttableContactsGrid/);
});

test("a column the scrape needs going missing is reported by name", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ propertyHeaders: PROPERTY_HEADERS.map((h) => (h.trim() === "Purchase  Price" ? "Price" : h)) })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /Purchase Price column/);
});

/* A grid that never loads is the timeout case: the button becomes pressable
   again so the filer gets told what didn't arrive rather than a spinner
   forever. `clockScale` runs the control's twenty-second ceiling in a tenth of
   a second so this test doesn't. */
test("grids that never arrive are reported once the control gives up waiting", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ contactRows: [], propertyRows: [] }),
    clockScale: 200
  });
  await settle();
  assert.equal(page.button.textContent, "Send to Hot Task", "it stops claiming to be loading");
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /hadn't finished loading/);
});

/* ── What the parser will accept as people and properties ── */

test("junk contacts and properties cost the import nothing", () => {
  for (const junk of ["a string", 42, null, {}, [null, 7, "x"], [{ name: "no type" }, { type: "Broker" }]]) {
    const result = parseHumperdinkPayload(payloadText({ contacts: junk, properties: junk }));
    assert.equal(result.ok, true, JSON.stringify(junk));
    assert.equal("contacts" in result.payload, false);
    assert.equal("properties" in result.payload, false);
  }
});

test("a property with no address is dropped rather than rendered as a bare price", () => {
  const result = parseHumperdinkPayload(
    payloadText({ properties: [{ address: "", purchasePrice: "$1" }, { address: "12 Elm St" }] })
  );
  assert.deepEqual(result.payload.properties, [{ address: "12 Elm St" }]);
});

test("a runaway grid is capped rather than pasted whole into a note", () => {
  const contacts = Array.from({ length: 50 }, () => ({ type: "Broker", name: "A" }));
  const properties = Array.from({ length: 100 }, (_, i) => ({ address: `${i} Elm St` }));
  const result = parseHumperdinkPayload(payloadText({ contacts, properties }));
  assert.equal(result.payload.contacts.length, 20);
  assert.equal(result.payload.properties.length, 40);
});

/* A grid that is present, loaded and genuinely empty is indistinguishable from
   one that is still filling: Humperdink offers no "loaded, and there are none"
   signal. So an empty grid is refused rather than imported as an absence — a
   note that quietly lost its borrower is worse than one that didn't get made.
   Every LOI is filed against a loan that has a borrower and a property. */
test("a grid that stays empty is refused, not imported as a loan with nobody on it", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ contactRows: [] }),
    clockScale: 200
  });
  await settle();
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.button.textContent, /contacts \(they hadn't finished loading\)/);
});

/* ── Landing where you can paste (#198) ──────────────────

   Copying was only half the trip: the filer still had to switch to Teams, find
   Hot Task and open New Task before the payload had anywhere to go. The control
   now does both — copy, then open Hot Task on the create form.

   The link carries no data. It says "open the create form" and nothing else,
   because the loan is already on the clipboard, and the URL it builds has to be
   the one `teamsTaskDeepLink` builds — the userscript can't import from this
   workspace, so this is what stops the two drifting. */

const HOT_TASK_APP_ID = "6a1b2c3d-0000-4444-8888-abcdefabcdef";

const goodPage = (over = {}) => runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, ...over });

/* The id the file ships with, which is our real Teams app id — the same value
   in teams-app/operation-hot-task-teams/manifest.json. It used to ship blank for
   each installer to fill in; that was reversed once it turned out the repo
   already committed the id in two other places, so making eleven people look it
   up bought nothing. Read out of the file rather than restated, so the two
   assertions below can say "as shipped" and mean it. */
const SHIPPED_APP_ID = USERSCRIPT.match(APP_ID_LINE_VALUE)?.[1];

test("the file ships with our app id, so a fresh install opens Hot Task", async () => {
  assert.equal(SHIPPED_APP_ID, "bca6db0b-b2b7-423f-8c22-f4348f3a0340");
  const page = goodPage({ appId: SHIPPED_APP_ID });
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(page.opened.length, 1);
  assert.equal(page.opened[0].href, teamsTaskDeepLink(SHIPPED_APP_ID, undefined, { createForm: true }));
  assert.match(page.button.textContent, /Copied — opening Hot Task/);
});

/* Blanking the constant stays supported and documented: an org catalog can
   assign an app id other than the manifest's, and copy-and-tell is the honest
   fallback when nobody knows which. */
test("blanked, it still copies and says to paste it yourself", async () => {
  const page = goodPage({ appId: "" });
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.deepEqual(page.opened, []);
  assert.match(page.button.textContent, /Copied — paste it into Hot Task/);
});

test("with an app id, one press copies the loan AND opens Hot Task", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(JSON.parse(page.copied[0]).loanName, "Adams - Harbor");
  assert.equal(page.opened.length, 1);
  assert.match(page.button.textContent, /Copied — opening Hot Task/);
});

test("the url it opens is the one the shared builder builds", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  assert.equal(page.opened[0].href, teamsTaskDeepLink(HOT_TASK_APP_ID, undefined, { createForm: true }));
});

test("the link names no task and carries no loan data — the clipboard has it", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  const context = JSON.parse(new URL(page.opened[0].href).searchParams.get("context"));
  assert.deepEqual(context, { openCreateForm: true });
  assert.equal(readCreateFormIntent({ page: context }), true);
  assert.doesNotMatch(page.opened[0].href, /Adams|335203/);
});

/* Humperdink's loan page is the thing the filer is reading; sending them off it
   to file a task about it would cost more than the two clicks this saves. */
test("Hot Task opens in a new tab, leaving the loan page where it was", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  assert.equal(page.opened[0].target, "_blank");
});

/* `window.open(url, "_blank", "noopener")` returns null on SUCCESS, which is
   exactly what a blocked popup returns — pass it and every successful open
   reports itself as refused. The opener is severed on the handle instead. */
test("the noopener feature is not passed, so a real open isn't read as a refusal", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  assert.equal(page.opened[0].features, undefined);
  assert.equal(page.openedWindows[0].opener, null);
  assert.match(page.button.textContent, /Copied — opening Hot Task/);
});

test("a second press opens a second time rather than going quiet", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID });
  await page.press();
  await page.press();
  assert.equal(page.copied.length, 2);
  assert.equal(page.opened.length, 2);
});

/* ── Nothing on the clipboard, nowhere to go ─────────────

   The copy is the capability and the link is the convenience, so the link never
   runs ahead of it. Landing on an empty create form with nothing to paste is
   worse than staying put. */

test("a page it couldn't read copies nothing and opens nothing", async () => {
  const page = runUserscript({ title: "Humperdink", href: LOAN_URL, appId: HOT_TASK_APP_ID });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.opened, []);
});

test("a refused clipboard does not open Hot Task", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID, clipboard: "dead" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.opened, []);
  assert.match(page.button.textContent, /Couldn't reach the clipboard/);
});

test("a press while the grids are still loading opens nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    appId: HOT_TASK_APP_ID,
    grids: withGrids({ contactRows: [], propertyRows: [] })
  });
  assert.equal(page.button.textContent, "Loading…");
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.opened, []);
  assert.match(page.button.textContent, /Still loading/);
});

/* A control that silently did nothing would look identical to one that worked,
   which is why `copyText` reports a refused clipboard. Same rule here. */
test("a blocked popup is reported, and the copy still stands", async () => {
  const page = goodPage({ appId: HOT_TASK_APP_ID, popups: "blocked" });
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(page.opened.length, 1);
  assert.match(page.button.textContent, /Copied — couldn't open Hot Task/);
});
