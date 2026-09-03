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
  isLoanDetailsUrl,
  loanNameFromPageTitle,
  parseHumperdinkPayload
} from "../packages/shared/src/humperdink.ts";

const USERSCRIPT = readFileSync(new URL("../tools/humperdink/send-to-hot-task.user.js", import.meta.url), "utf8");

const LOAN_URL = "https://humperdink.loneoakfund.com/Loans/Details/335203";

/* ── A DOM small enough to read, big enough for the script ──

   The userscript touches exactly this much of the page: the title, the address
   bar, one button it creates and appends, and the clipboard. Anything it starts
   reaching for beyond this (a selector into Humperdink's markup, say) fails
   here loudly, which is the point. */
const runUserscript = ({ title, href, clipboard = "ok" }) => {
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
    getElementById: (id) => created.find((el) => el.mounted && el.id === id) ?? null,
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
  const result = parseHumperdinkPayload(payloadText({ terms: { loanAmount: "500000" }, contacts: [] }));
  assert.equal(result.ok, true);
  assert.equal(result.payload.loanName, "Adams - Harbor");
  assert.equal("terms" in result.payload, false, "the parser hands back only what it declares");
});
