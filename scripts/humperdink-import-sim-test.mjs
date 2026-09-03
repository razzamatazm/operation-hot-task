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

const USERSCRIPT = readFileSync(new URL("../tools/humperdink/send-to-hot-task.user.js", import.meta.url), "utf8");

const LOAN_URL = "https://humperdink.loneoakfund.com/Loans/Details/335203";

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

/* ── A DOM small enough to read, big enough for the script ──

   The userscript touches exactly this much of the page: the title, the address
   bar, one button it creates and appends, and the clipboard. Anything it starts
   reaching for beyond this (a selector into Humperdink's markup, say) fails
   here loudly, which is the point. */
const runUserscript = ({ title, href, clipboard = "ok", fields = TERMS_FIELDS }) => {
  const url = new URL(href);
  const copied = [];
  const created = [];
  let mountedButton = null;
  let buttonsMounted = 0;

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
    /* The script's own control first, then the page's terms fields. An id the
       page doesn't carry returns null, which is what a Humperdink release that
       renamed a field looks like from in here. */
    getElementById: (id) =>
      created.find((el) => el.mounted && el.id === id) ??
      (Object.prototype.hasOwnProperty.call(fields, id) ? { id, value: fields[id] } : null),
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
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  };

  const sandbox = { document, location: url, navigator, setTimeout: unrefed, clearTimeout, console, URL };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(USERSCRIPT, sandbox);

  return {
    copied,
    button: mountedButton,
    get buttonsMounted() {
      return buttonsMounted;
    },
    /* Tampermonkey can run the script again on a soft navigation. */
    remount() {
      vm.runInContext(USERSCRIPT, sandbox);
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

const scrapeNote = async (fields) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, fields });
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

test("its note is the core terms and nothing else", async () => {
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
      "Evaluation Fee: $1,750.00"
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
      "Partial Reconveyance"
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
  assert.deepEqual(headings, ["Loan Terms", "Junior Financing", "Blended Totals"]);
});
