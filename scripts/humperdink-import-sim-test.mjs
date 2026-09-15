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
import { HUMPERDINK_ARRIVAL_ID, humperdinkArrivalLink } from "../packages/shared/src/deep-link.ts";

const USERSCRIPT = readFileSync(new URL("../tools/humperdink/send-to-hot-task.user.js", import.meta.url), "utf8");

const LOAN_URL = "https://humperdink.loneoakfund.com/Loans/Details/335203";

/* What the control says once the loan is on the clipboard. It then opens Hot
   Task in Teams desktop on a new LOI Check (#414), so it says that, not where to
   paste. */
const COPIED = "Copied. Opening Hot Task in Teams…";

/* The one live Teams install's manifest (teams-app/manifest.json beside it is a
   template with a placeholder id). The userscript hard-codes this app id, and
   the drift test below holds the two together. */
const LIVE_MANIFEST = JSON.parse(
  readFileSync(new URL("../teams-app/operation-hot-task-teams/manifest.json", import.meta.url), "utf8")
);

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
  txtpartialReconveyance: "",
  /* The extension notes box sits on every loan, used or not (#442). Its rows
     don't: a loan with no extensions has no row elements at all. */
  extensionstextarea: ""
};

/** The same page with some fields overridden; `null` removes the element. */
const withFields = (over = {}) => {
  const fields = { ...TERMS_FIELDS, ...over };
  for (const [id, value] of Object.entries(fields)) if (value === null) delete fields[id];
  return fields;
};

/* ── The panel switches (#442) ──────────────────────────────

   Each conditional panel has an on/off switch in its header. Humperdink keeps
   the panel's inputs on the page, figures and all, whichever way the switch is
   set, so the switch is the only thing that says whether the loan uses it.
   Seen live on 2026-09-15: with Disbursement Options switched off, Draw
   Minimum and Increment still held `$10,000`. A switch is on when its
   `.toggle-on` child also carries `active`.

   The saved page's loan uses none of the panels, so they default to off. */
const SWITCH_IDS = {
  extensions: "toggleExtensions",
  juniorFinancing: "toggleJuniorFinancePermit",
  sellerFinancing: "toggleSellerFinancingPermit",
  disbursement: "toggleHoldBack",
  interestReserve: "toggleInterestReserve",
  partialReconveyance: "toggleReconveyance"
};

/** Every switch off, with some flipped; `null` removes that switch's element. */
const withSwitches = (over = {}) => {
  const switches = Object.fromEntries(Object.values(SWITCH_IDS).map((id) => [id, false]));
  for (const [panel, on] of Object.entries(over)) {
    if (on === null) delete switches[SWITCH_IDS[panel]];
    else switches[SWITCH_IDS[panel]] = on;
  }
  return switches;
};

const SWITCHES_OFF = withSwitches();
const SWITCHES_ON = withSwitches(Object.fromEntries(Object.keys(SWITCH_IDS).map((panel) => [panel, true])));

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

/** The street line of a grid address cell, the way the scrape takes it. */
const streetOf = (html) =>
  String(html)
    .split(/<br\s*\/?>/i)[0]
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,+$/, "");

/** The whole address on one line, for telling two properties on one street apart. */
const wholeAddressOf = (html) =>
  String(html)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

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
   bar, Humperdink's LOI button in the Loan Terms header (its control mounts
   beside it), the note it pins under that control, and the clipboard. Anything
   it starts reaching for beyond this fails here loudly, which is the point. */
const CONTROL_ID = "hot-task-send-control";
const hasClass = (node, name) => String(node.className ?? "").split(/\s+/).includes(name);
const NOTE_ID = "hot-task-send-message";

const runUserscript = ({
  title,
  href,
  clipboard = "ok",
  fields = TERMS_FIELDS,
  switches = SWITCHES_OFF,
  grids = withGrids(),
  /* Each property's release price, by street address, the way its property
     details partial carries it: a bare number in the input's `value`, or "". */
  releasePrices = {},
  /* How Humperdink answers the property details fetch: "ok", "fail" (an error
     status), "hang" (never answers) or "no-input" (a page with no release
     price field). */
  releaseFetch = "ok",
  /* "painted", or "reversed" for grid row data held in a different order from
     the rows the grid painted, as a sorted grid would. */
  propertyDataOrder = "painted",
  /* Whether the page carries the LOI button the control mounts beside. The real
     page does; `false` is a Humperdink release that moved it, where the control
     gives up looking and takes the corner as a floating button. */
  anchor = true,
  /* The LOI button's insides, as a tree the script can copy (see `treeNode`).
     Left out, the LOI button can't be copied and the script builds its control
     by hand, which is the fallback. */
  loiMarkup = null,
  /* Divides every timer the script sets, so a test can run the control's
     twenty-second wait-for-the-grids ceiling in a fraction of a second. */
  clockScale = 1
}) => {
  const url = new URL(href);
  const copied = [];
  const created = [];
  const observers = [];
  let mountedButton = null;
  let buttonsMounted = 0;
  let page = grids;

  const mountControl = (el) => {
    el.mounted = true;
    mountedButton = el;
    buttonsMounted += 1;
  };

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

  /* A panel switch: a `.toggle-on` child that carries `active` when it's on. */
  const switchElement = (id, on) => ({
    id,
    querySelector: (selector) => (selector === ".toggle-on" ? { className: on ? "toggle-on active" : "toggle-on" } : null)
  });

  /* The properties grid's own row data, which is where a property's ids live;
     the painted cells don't carry them. Read through the page's jQuery, the
     way Humperdink's own OpenProperty reads it. */
  /* The data holds the address unescaped where the painted cell's HTML escapes
     it (`&` against `&amp;`). */
  const propertyData = () => {
    const rows = (page.propertyRows ?? []).map((cells, i) => ({
      Address: String(cells[2]).replace(/&amp;/g, "&"),
      TransactionType: cells[3],
      FKPropertyID: 7000 + i,
      PKLoanPropertyDetailID: 9000 + i
    }));
    return propertyDataOrder === "reversed" ? rows.reverse() : rows;
  };
  const jQuery = (selector) => ({
    jqxGrid(method) {
      if (selector !== "#PropertiesGrid" || method !== "getrows") {
        throw new Error(`the fake jQuery doesn't support ${selector} ${method}`);
      }
      return propertyData();
    }
  });

  /* Humperdink's property details partial, one GET per property. */
  const fetched = [];
  const fetch = (href, init = {}) => {
    fetched.push({ href: String(href), credentials: init.credentials });
    if (releaseFetch === "hang") return new Promise(() => {});
    if (releaseFetch === "fail") return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("") });
    const query = new URL(String(href), url.origin).searchParams;
    const row = propertyData().find(
      (r) =>
        String(r.FKPropertyID) === query.get("pkpropertyid") &&
        String(r.PKLoanPropertyDetailID) === query.get("pkloanspropertydetails")
    );
    const html =
      row && releaseFetch !== "no-input"
        ? `<input class="font16 form-control" id="txtReleasePrice" name="LoansPropertyDetails.PropertyReleasePrice" type="text" value="${releasePrices[wholeAddressOf(row.Address)] ?? releasePrices[streetOf(row.Address)] ?? ""}">`
        : "<div>no release price here</div>";
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
  };

  /* Just enough of a parser to find one input and read its attributes. */
  class DOMParser {
    parseFromString(html) {
      return {
        getElementById(id) {
          const tag = new RegExp(`<input[^>]*\\sid="${id}"[^>]*>`).exec(html);
          if (!tag) return null;
          return {
            getAttribute(name) {
              const found = new RegExp(`\\s${name}="([^"]*)"`).exec(tag[0]);
              return found ? found[1] : null;
            }
          };
        }
      };
    }
  }

  const createElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      type: "",
      className: "",
      title: "",
      innerHTML: "",
      textContent: "",
      value: "",
      mounted: false,
      style: {
        cssText: "",
        setProperty(name, value) {
          this[name] = value;
        },
        removeProperty(name) {
          delete this[name];
        }
      },
      attributes: {},
      listeners: {},
      classList: { add() {}, remove() {} },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      addEventListener(event, fn) {
        (this.listeners[event] ??= []).push(fn);
      },
      /* The inline control's label lives in a child a browser would find. This
         DOM has no children, so the script writes the label onto the control
         itself: the same words in the same control, as far as a test can tell. */
      querySelector() {
        return null;
      },
      getBoundingClientRect() {
        return { top: 0, left: 600, bottom: 24, right: 700 };
      },
      remove() {
        this.mounted = false;
      },
      select() {},
      click() {
        const target = this;
        const event = {
          preventDefault() {},
          stopPropagation() {
            target.propagationStopped = true;
          }
        };
        for (const fn of this.listeners.click ?? []) fn(event);
      }
    };
    created.push(el);
    return el;
  };

  /* A small element tree, just enough for the script to copy the LOI button and
     swap its icon and name: children, text nodes, attributes, and lookups by
     class. A string in `children` is a text node. */
  const elementsIn = (node) => (node.childNodes ?? []).filter((child) => child.nodeType !== 3);
  const descendantsOf = (node) => elementsIn(node).flatMap((child) => [child, ...descendantsOf(child)]);
  const treeNode = (spec, parentNode = null) => {
    if (typeof spec === "string") return { nodeType: 3, nodeValue: spec, parentNode };
    const el = createElement(spec.tag ?? "div");
    const attributes = [];
    Object.assign(el, {
      nodeType: 1,
      parentNode,
      className: spec.className ?? "",
      attributes,
      setAttribute(name, value) {
        const found = attributes.find((attribute) => attribute.name === name);
        if (found) found.value = value;
        else attributes.push({ name, value });
      },
      removeAttribute(name) {
        const at = attributes.findIndex((attribute) => attribute.name === name);
        if (at >= 0) attributes.splice(at, 1);
        if (name === "id") this.id = "";
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      /* Only the two selectors the script uses. Anything else fails loudly
         rather than quietly matching everything. */
      querySelectorAll(selector) {
        const all = descendantsOf(this);
        if (selector === "*") return all;
        if (/^\.[\w-]+$/.test(selector)) return all.filter((node) => hasClass(node, selector.slice(1)));
        throw new Error(`the fake DOM doesn't support the selector ${selector}`);
      },
      replaceChild(next, old) {
        this.childNodes[this.childNodes.indexOf(old)] = next;
        next.parentNode = this;
      },
      classList: {
        add: (...names) => {
          el.className = [...new Set([...el.className.split(/\s+/), ...names])].filter(Boolean).join(" ");
        },
        remove: (...names) => {
          el.className = el.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(" ");
        }
      }
    });
    for (const [name, value] of Object.entries(spec.attrs ?? {})) el.setAttribute(name, value);
    el.id = spec.attrs?.id ?? "";
    /* Inline declarations land on `style` the way a browser parses them. */
    for (const declaration of String(spec.attrs?.style ?? "").split(";")) {
      const [name, ...value] = declaration.split(":");
      if (name.trim()) el.style.setProperty(name.trim(), value.join(":").trim());
    }
    el.childNodes = (spec.children ?? []).map((child) => treeNode(child, el));
    return el;
  };

  /* Humperdink's LOI button, inside the Loan Terms panel header. */
  const loiButton = {
    id: "btnLOIFile",
    className: "jqx-rc-all jqx-button jqx-widget jqx-fill-state-normal",
    closest: (selector) => (selector === ".loanpanelheader" ? {} : null),
    insertAdjacentElement: (_position, el) => mountControl(el),
    ...(loiMarkup ? { cloneNode: () => treeNode(loiMarkup) } : {})
  };

  const document = {
    title,
    createElement,
    documentElement: {},
    /* The script's own control first, then the LOI button, then the page's
       terms fields and its two grids. An id the page doesn't carry returns
       null, which is what a Humperdink release that renamed something looks
       like from in here. */
    getElementById: (id) =>
      created.find((el) => el.mounted && el.id === id) ??
      (anchor && id === loiButton.id ? loiButton : null) ??
      (Object.prototype.hasOwnProperty.call(switches, id) ? switchElement(id, switches[id]) : null) ??
      (Object.prototype.hasOwnProperty.call(fields, id) ? { id, value: fields[id] } : null) ??
      (Object.prototype.hasOwnProperty.call(GRID_ELEMENTS, id) ? GRID_ELEMENTS[id]() : null),
    body: {
      appendChild(el) {
        if (el.tagName === "BUTTON") mountControl(el);
        else el.mounted = true;
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
  /* The control also polls for the Loan Terms header on an interval when the
     header isn't there yet. Same scaling, same unref. */
  const unrefedInterval = (fn, ms) => {
    const handle = setInterval(fn, ms / clockScale);
    handle.unref?.();
    return handle;
  };

  /* The control watches the page so it can put itself back when Humperdink
     repaints the header. `repaintHeader` below is that repaint. */
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }

  /* Every tab the control asks the browser to open. It never opens a tab: Hot
     Task is reached by navigating to an `msteams:` link (#414), which Chrome
     hands to Teams desktop without leaving the loan page. So this stays empty. */
  const opened = [];
  const open = (href, target, features) => {
    opened.push({ href, target, features });
    return { href, opener: null };
  };

  /* Every navigation the control makes, whichever way it asks for one, with how
     many copies had landed at that moment, so a test can tell "copied, then
     opened" from "opened, then copied". The page's own address stays readable,
     because the scrape reads the loan link off it. */
  const navigated = [];
  const navigate = (href) => navigated.push({ href: String(href), copiesBefore: copied.length });
  const location = {
    get href() {
      return url.href;
    },
    set href(next) {
      navigate(next);
    },
    assign: navigate,
    replace: navigate
  };

  const source = USERSCRIPT;
  const sandbox = {
    document,
    location,
    navigator,
    open,
    setTimeout: unrefed,
    clearTimeout,
    setInterval: unrefedInterval,
    clearInterval,
    MutationObserver,
    innerWidth: 1280,
    console,
    URL,
    jQuery,
    fetch,
    DOMParser
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    copied,
    opened,
    navigated,
    fetched,
    /* The control on the page: inline beside the LOI button, or the floating
       fallback once the script gives up on the header. A getter, because the
       fallback arrives after the script has returned. */
    get button() {
      return mountedButton;
    },
    get buttonsMounted() {
      return buttonsMounted;
    },
    /* How many controls are on the page right now, as opposed to ever. */
    get controlsOnPage() {
      return created.filter((el) => el.mounted && el.id === CONTROL_ID).length;
    },
    /* What the control is telling the filer. Inline, messages go in the note
       pinned under the control; the floating button says them on its own label. */
    get said() {
      const note = created.find((el) => el.mounted && el.id === NOTE_ID);
      if (note) return note.textContent;
      return mountedButton?.tagName === "BUTTON" ? mountedButton.textContent : "";
    },
    /* Whether the control is saying it is still waiting for the grids. Inline it
       cannot spend its label on that, so it dims and says so on hover. */
    get loading() {
      return /Still loading/.test(mountedButton?.title ?? "");
    },
    /* Humperdink repainting the Loan Terms header, which takes the control with it. */
    repaintHeader() {
      if (mountedButton) mountedButton.mounted = false;
      for (const observer of observers) observer.callback([]);
    },
    /* Tampermonkey can run the script again on a soft navigation. */
    remount() {
      vm.runInContext(source, sandbox);
    },
    /* Humperdink's background fetch landing, after the script already mounted. */
    loadGrids(next) {
      page = { ...page, ...next };
    },
    /* Let what the control already has in flight land. The release-price
       fetches it starts once the properties are in answer on promises here,
       with no timer, so one turn of the event loop is enough. */
    async settled() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    /* The pointer reaching the control, which re-fetches the release prices. */
    hover() {
      for (const fn of mountedButton.listeners.mouseenter ?? []) fn({});
    },
    /* Let the click handler's clipboard promise settle before we read the label. */
    async press() {
      await this.settled();
      mountedButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
};

/* ── The control on the Humperdink page ─────────────────── */

test("the script mounts its Export to HT control beside the LOI button in the Loan Terms header", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.settled();
  assert.ok(page.button, "a control went into the header");
  assert.equal(page.button.tagName, "DIV", "shaped like Humperdink's own header buttons");
  assert.equal(page.button.attributes.role, "button");
  assert.match(page.button.className, /jqx-button/, "wearing the LOI button's classes");
  assert.equal(page.button.textContent, "Export to HT");
  assert.equal(page.button.title, "Copy this loan and open a new LOI Check in Hot Task");
});

/* A Humperdink release that moves the LOI button must not leave the loan page
   with no control at all: the script keeps looking for the header, then takes
   the corner. */
test("with no Loan Terms header to sit in, the control takes the corner once it stops looking", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, anchor: false, clockScale: 200 });
  assert.equal(page.button, null, "it looks for the header before settling for the corner");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(page.button.tagName, "BUTTON");
  assert.equal(page.button.textContent, "Export to HT", "the same name the parser's messages tell people to press");
  assert.equal(page.controlsOnPage, 1);
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(page.said, COPIED, "the floating button says it on its own label");
});

test("Humperdink repainting the header puts the control back, once", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  page.repaintHeader();
  assert.equal(page.controlsOnPage, 1, "one control on the page, not none and not two");
  assert.equal(page.buttonsMounted, 2, "a fresh one went back in");
  await page.press();
  assert.equal(page.copied.length, 1, "and it works");
});

test("a message goes in a note under the inline control, not over its label", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.press();
  assert.equal(page.said, COPIED);
  assert.equal(page.button.textContent, "Export to HT", "the header button never changes width");
});

/* The inline control is a copy of the LOI button with its icon and name
   swapped, so it lines up with the bar by construction. Hand-tuned margins sat
   a pixel or two off. This is the real LOI button as Humperdink renders it
   (2026-09-13), plus a hover class and an inline handler and inner id, which a
   copy must not keep either. */
const LOI_MARKUP = {
  className:
    "loanpaneldiv jqx-rc-all jqx-rc-all-Lending jqx-button jqx-button-Lending jqx-widget jqx-widget-Lending jqx-fill-state-normal jqx-fill-state-normal-Lending jqx-fill-state-hover",
  attrs: {
    "lending-controls-button": "",
    id: "btnLOIFile",
    name: "LOI",
    onclick: "OpenLOIFile()",
    style: "padding-left: 10px !important; width: 60px; height: 24px;",
    role: "button",
    "aria-disabled": "false"
  },
  children: [
    {
      tag: "span",
      className: "fa fa-file-word-o fa-lg loanSettings",
      attrs: { style: "font-size: 13px;margin-right: 5px;margin-top: 2px;" }
    },
    { tag: "div", attrs: { id: "lblLOI", style: "margin-top: 3px;" }, children: ["\n                        LOI\n                    "] }
  ]
};
const nodesOf = (node) => [node, ...(node.childNodes ?? []).flatMap(nodesOf)];
const visibleText = (node) =>
  node.nodeType === 3 ? node.nodeValue : node.childNodes ? node.childNodes.map(visibleText).join("") : node.textContent;

test("the inline control is a copy of the LOI button, with its own icon and name", () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, loiMarkup: LOI_MARKUP });
  const nodes = nodesOf(page.button);
  assert.equal(page.button.id, CONTROL_ID);
  assert.ok(page.button.childNodes, "copied, not built");
  assert.match(page.button.className, /jqx-button/);
  assert.doesNotMatch(page.button.className, /hover/, "not stuck looking hovered");
  assert.equal(visibleText(page.button).trim(), "Export to HT");
  const icon = nodes.find((node) => hasClass(node, "fa"));
  assert.deepEqual(icon.className.split(" "), ["fa", "fa-lg", "loanSettings", "fa-share-square-o"]);
  assert.ok(
    nodes.every((node) => node === page.button || !node.id),
    "no second btnLOIFile, and no copy of any id inside it"
  );
  const attributeNames = nodes.flatMap((node) => (Array.isArray(node.attributes) ? node.attributes.map((a) => a.name) : []));
  for (const identity of ["id", "name", "lending-controls-button", "onclick"]) {
    assert.ok(!attributeNames.includes(identity), `the LOI button's ${identity} did not come along`);
  }
  assert.ok(attributeNames.includes("aria-disabled"), "presentation attributes stay");
  assert.equal(page.button.style.width, undefined, "sized to its own name, not LOI's 60px");
  assert.equal(page.button.style.height, "24px", "the rest of the LOI button's box stays");
});

test("a copy taken while LOI is disabled doesn't look disabled", () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    loiMarkup: {
      ...LOI_MARKUP,
      className: `${LOI_MARKUP.className} jqx-fill-state-disabled jqx-fill-state-disabled-Lending`,
      attrs: { ...LOI_MARKUP.attrs, "aria-disabled": "true" }
    }
  });
  assert.doesNotMatch(page.button.className, /disabled/);
  assert.equal(page.button.attributes.find((attribute) => attribute.name === "aria-disabled").value, "false");
});

/* The control wears LOI's classes, so a Humperdink handler listening higher up
   the page for presses on its header buttons must never see this one. */
test("a press on the copied control stops at the control", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, loiMarkup: LOI_MARKUP });
  await page.press();
  assert.equal(page.button.propagationStopped, true);
  assert.equal(page.copied.length, 1);
});

test("a name written straight into the LOI button is swapped too", () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    loiMarkup: { className: "jqx-button", children: [{ tag: "span", className: "fa fa-file-word-o" }, " LOI"] }
  });
  assert.ok(page.button.childNodes, "copied, not built");
  assert.equal(visibleText(page.button).trim(), "Export to HT");
});

test("an LOI button with no icon to swap gets the hand-built control instead", () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    loiMarkup: { className: "jqx-button", children: ["LOI"] }
  });
  assert.equal(page.button.childNodes, undefined, "built, not copied");
  assert.equal(page.button.textContent, "Export to HT");
});

test("the copied control presses, and comes back once after a repaint", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, loiMarkup: LOI_MARKUP });
  page.repaintHeader();
  assert.equal(page.controlsOnPage, 1);
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(page.said, COPIED);
  assert.equal(visibleText(page.button).trim(), "Export to HT", "the header button never changes width");
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
  assert.equal(page.said, COPIED);
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
  assert.match(page.said, /Couldn't read the loan name/);
});

test("an empty page title reports the problem and copies nothing", async () => {
  const page = runUserscript({ title: "", href: LOAN_URL });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Couldn't read/);
});

test("a page that isn't a loan details page reports the problem and copies nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: "https://humperdink.loneoakfund.com/Loans/Index"
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /loan details URL/);
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
  assert.match(page.said, /loan details URL/);
});

test("a browser with no async clipboard API falls back to execCommand", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, clipboard: "no-async-api" });
  await page.press();
  assert.equal(parseHumperdinkPayload(page.copied[0]).ok, true);
  assert.equal(page.said, COPIED);
});

test("a refused clipboard says so instead of claiming a copy", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, clipboard: "dead" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Couldn't reach the clipboard/);
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
    version: 2,
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
    assert.match(result.error, /Press Export to HT on the loan page/, "it names the button the filer actually sees");
  }
});

test("JSON from something else entirely is not mistaken for ours", () => {
  const result = parseHumperdinkPayload(JSON.stringify({ loanName: "Adams", loanUrl: LOAN_URL }));
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't a Humperdink payload/);
});

/* Since the paste box went (2026-09-14) every paste on an LOI Check passes
   through the parser, so the form has to tell a stray paste, which it lets
   through silently, from an export it can't read, which it refuses out loud. */
test("a failure says whether the text was an export at all", () => {
  for (const stray of ["", "hello", "{not json", "[1,2,3]", JSON.stringify({ loanName: "Adams", loanUrl: LOAN_URL })]) {
    const result = parseHumperdinkPayload(stray);
    assert.equal(result.ok, false);
    assert.equal(result.ours, false, `${stray} is not an export`);
  }
  for (const broken of [{ version: 99 }, { version: undefined }, { loanName: "" }, { loanUrl: "https://humperdink.loneoakfund.com/Loans/Index" }]) {
    const result = parseHumperdinkPayload(payloadText(broken));
    assert.equal(result.ok, false);
    assert.equal(result.ours, true, `${JSON.stringify(broken)} is an export it can't read`);
  }
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
   must never be answered with "press Export to HT, then paste here" — the
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

const scrapeTerms = async (fields, switches = SWITCHES_OFF) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, fields, switches });
  await page.press();
  assert.equal(page.copied.length, 1, page.said);
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true, result.error);
  return result.payload.terms ?? {};
};

const scrapeNote = async (fields, grids = withGrids(), switches = SWITCHES_OFF) => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, fields, grids, switches });
  await page.press();
  assert.equal(page.copied.length, 1, page.said);
  const result = parseHumperdinkPayload(page.copied[0]);
  assert.equal(result.ok, true, result.error);
  return humperdinkNoteText(result.payload);
};

test("the core terms travel, read by element id", async () => {
  const terms = await scrapeTerms(TERMS_FIELDS);
  assert.equal(terms.loanAmount, "$1,300,000");
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
    "partialReconveyance",
    "extensions",
    "extensionNotes",
    "juniorFinancingPermitted",
    "sellerFinancingPermitted"
  ]) {
    assert.equal(absent in terms, false, `${absent} should not travel on a loan that doesn't use it`);
  }
});

/* The whole note the saved loan produces: its two contacts first, then the core
   terms, then its one property, which it refinances and has no purchase price
   for. */
test("its note is its people, the core terms and its property, and nothing else", async () => {
  const note = await scrapeNote(TERMS_FIELDS);
  assert.equal(
    note,
    [
      "Contacts",
      "Broker: Dan LuVisi",
      "Borrower: Duda Adams",
      "",
      "Loan Terms",
      "Loan Amount: $1,300,000",
      "Term: 24 months",
      "Interest Rate: Months 1–12 at 7.90%",
      "Interest Rate: Months 13–24 at 8.40%",
      "Origination Fee: 2.0000 points",
      "Broker Fee: 2.0000 points",
      "Evaluation Fee: $1,750.00",
      "",
      "Properties",
      "217 to 225 S. Harbor Boulevard (Refinance-Standard)"
    ].join("\n")
  );
});

/* The page still carries both fields; the desk doesn't want them in the note. */
test("Total Value and LTV stay behind", async () => {
  const note = await scrapeNote(TERMS_FIELDS);
  assert.doesNotMatch(note, /Total Value|LTV|\$3,260,267|39\.87%/);
});

/* An older script still sends them; the note leaves them out all the same. */
test("Total Value and LTV from an older script are dropped", () => {
  const result = parseHumperdinkPayload(payloadText({ terms: { loanAmount: "$1", totalValue: "$9", ltv: "40%" } }));
  assert.deepEqual(result.payload.terms, { loanAmount: "$1" });
});

/* Humperdink pre-fills its unused CONDITIONAL panels with zeroes rather than
   blanks, so "is it empty" is not the test there — `Rate: 0.00%` under a Junior
   Financing heading is exactly the empty label #196 rules out. */
test("a zero in an unused panel is not a value", async () => {
  const terms = await scrapeTerms(
    withFields({ SecondTDRate: "0.00%", SellerFinancingAmount: "$0.00", interestReserveMonths: "0" }),
    SWITCHES_ON
  );
  assert.equal("juniorFinancingRate" in terms, false);
  assert.equal("sellerFinancingAmount" in terms, false);
  assert.equal("interestReserveMonths" in terms, false);
});

test("junior financing travels when the loan has some, and brings the blended figures", async () => {
  const terms = await scrapeTerms(
    withFields({ JuniorFinancingAmount: "$200,000.00", SecondTDRate: "10.00%", SecondTDFeePoints: "1.0000" }),
    withSwitches({ juniorFinancing: true })
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
    }),
    SWITCHES_ON
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
      ExtensionMonthStart1: "1",
      ExtensionMonthEnd1: "6",
      ExtensionRate1: "8.90%",
      ExtensionPoints1: "1.00",
      JuniorFinancingAmount: "$200,000.00",
      SecondTDRate: "10.00%",
      SellerFinancingAmount: "$50,000.00",
      InitialDisbursed: "$900,000.00",
      interestReserveAmount: "$40,000.00",
      interestReserveMonths: "6",
      txtpartialReconveyance: "Release lot 4 at $300k paydown."
    }),
    withGrids(),
    SWITCHES_ON
  );
  assert.deepEqual(
    note.split("\n\n").map((block) => block.split("\n")[0]),
    [
      "Contacts",
      "Loan Terms",
      "Extensions",
      "Loan Term Notes",
      "Junior Financing",
      "Blended Totals",
      "Seller Financing",
      "Disbursement Options",
      "Interest Reserve",
      "Partial Reconveyance",
      "Properties"
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
    fields: withFields({ LoanTerm: null, txtEvaluation: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /loan terms/);
  assert.match(page.said, /LoanTerm/);
  assert.match(page.said, /txtEvaluation/);
});

test("a page missing the first interest rate row reports it too", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    fields: withFields({ InterestRate1: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /InterestRate1/);
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
      txtReasonForLoan: "Buy out a partner",
      txtExitStrategy: "Sale",
      txtBorrowerExperience: "12 deals",
      txtRedFlags: "None",
      comboLender: "Lone Oak",
      comboStatus: "Approved",
      comboClosingDate: "2026-01-15"
    })
  );
  // The loan-level Lender field stays behind; a Lender contact is another matter (#442).
  for (const excluded of ["$1,500,000", "Buy out a partner", "Sale", "12 deals", "Lone Oak", "Approved", "2026-01-15"]) {
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
  const result = withTerms({ loanAmount: 500000, evaluationFee: "  ", originationFeePoints: "$1", termMonths: null });
  assert.deepEqual(result.payload.terms, { originationFeePoints: "$1" });
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

/* A zero in the CORE set is a loan term, not an unused panel, so it still says
   so — except the broker fee, which the desk only wants to see when there is
   one. */
test("a zero in the core terms is a real term and says so", async () => {
  const note = await scrapeNote(withFields({ OriginationFeePoints: "0.0000", txtEvaluation: "$0.00" }));
  assert.match(note, /Origination Fee: 0\.0000 points/);
  assert.match(note, /Evaluation Fee: \$0\.00/);
});

test("a zero broker fee is left out of the note", async () => {
  const note = await scrapeNote(withFields({ BrokerFeePoints: "0.0000" }));
  assert.doesNotMatch(note, /Broker Fee/);
  assert.match(note, /Origination Fee: 2\.0000 points\nEvaluation Fee/);
});

test("a broker fee that isn't zero still shows", async () => {
  const note = await scrapeNote(withFields({ BrokerFeePoints: "1.5000" }));
  assert.match(note, /Broker Fee: 1\.5000 points/);
});

/* #196 lists the combined/blended figures as their own conditional group, and
   they only mean anything next to a junior loan. */
test("the blended figures read as their own block under the junior loan", async () => {
  const note = await scrapeNote(
    withFields({ JuniorFinancingAmount: "$200,000.00", SecondTDRate: "10.00%" }),
    withGrids(),
    withSwitches({ juniorFinancing: true })
  );
  const headings = note.split("\n\n").map((block) => block.split("\n")[0]);
  assert.deepEqual(headings, ["Contacts", "Loan Terms", "Junior Financing", "Blended Totals", "Properties"]);
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
  assert.equal(page.copied.length, 1, page.said);
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

/* A silent borrower travels under its own name rather than being folded into
   Borrower, so the note says which one somebody is. Grouped after the
   borrowers whatever order the grid holds them in. */
test("a silent borrower travels under its own name, after the borrowers", async () => {
  const rows = [
    ["", "", "Silent Borrower", "Pat Quiet", "", "", "", "", ""],
    ...CONTACT_ROWS,
    ["", "", "Borrower", "Marta Adams", "", "", "", "", ""]
  ];
  const payload = await scrapePayload({ grids: withGrids({ contactRows: rows }) });
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" },
    { type: "Borrower", name: "Marta Adams" },
    { type: "Silent Borrower", name: "Pat Quiet" }
  ]);
  const contacts = humperdinkNoteSections(payload).find((section) => section.heading === "Contacts");
  assert.deepEqual(contacts.lines, [
    "Broker: Dan LuVisi",
    "Borrower: Duda Adams",
    "Borrower: Marta Adams",
    "Silent Borrower: Pat Quiet"
  ]);
});

test("a silent borrower matches on the whole type, not as a kind of borrower", async () => {
  const rows = [["", "", "Silent Borrower", "Pat Quiet", "", "", "", "", ""]];
  const payload = await scrapePayload({ grids: withGrids({ contactRows: rows }) });
  assert.deepEqual(payload.contacts, [{ type: "Silent Borrower", name: "Pat Quiet" }], "not also carried as a Borrower");
});

/* The parser keeps contact type as text, so a payload carrying Silent Borrower
   from a v1.7+ script is read whole by any Hot Task that knows #197. */
test("the parser reads a silent borrower and the note prints it as sent", () => {
  const result = parseHumperdinkPayload(
    payloadText({
      contacts: [
        { type: "Broker", name: "Dan LuVisi" },
        { type: "Borrower", name: "Duda Adams" },
        { type: "Borrower", name: "Marta Adams" },
        { type: "Silent Borrower", name: "Pat Quiet" }
      ]
    })
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.payload.contacts.length, 4);
  assert.match(
    humperdinkNoteText(result.payload),
    /^Contacts\nBroker: Dan LuVisi\nBorrower: Duda Adams\nBorrower: Marta Adams\nSilent Borrower: Pat Quiet$/m
  );
});

/* #442: the desk writes loans on refinances as well as acquisitions, so every
   property on the loan travels, not only #197's acquisitions. The saved loan
   refinances its one property. */
test("a refinanced property travels, with its transaction type", async () => {
  const payload = await scrapePayload();
  assert.deepEqual(payload.properties, [
    { address: "217 to 225 S. Harbor Boulevard", transactionType: "Refinance-Standard" }
  ]);
  assert.match(humperdinkNoteText(payload), /Properties\n217 to 225 S\. Harbor Boulevard \(Refinance-Standard\)$/);
});

/* Humperdink packs the whole address into one `<br/>`-split cell. */
test("a property carries its street address, its transaction type and its purchase price", async () => {
  const payload = await scrapePayload({ grids: withGrids({ propertyRows: [acquisitionRow()] }) });
  assert.deepEqual(payload.properties, [
    { address: "1400 Ocean Avenue", transactionType: "Acquisition", purchasePrice: "$850,000" }
  ]);
});

test("nothing else off the property row travels", async () => {
  const note = await scrapeNote(TERMS_FIELDS, withGrids({ propertyRows: [acquisitionRow()] }));
  assert.equal(note.split("\n\n").pop(), "Properties\n1400 Ocean Avenue (Acquisition), Purchase Price $850,000");
  for (const excluded of ["Apartment", "Long Beach", "90802", "Los Angeles"]) {
    assert.doesNotMatch(note, new RegExp(excluded), `${excluded} is not what an LOI check needs`);
  }
});

test("a property travels whatever its transaction type", async () => {
  for (const transaction of ["Acquisition", "Acquisition with Refi Cross", "Purchase-Standard", "Refinance-Standard"]) {
    const payload = await scrapePayload({
      grids: withGrids({ propertyRows: [acquisitionRow({ transaction })] })
    });
    assert.equal(payload.properties.length, 1, transaction);
    assert.equal(payload.properties[0].transactionType, transaction);
  }
});

/* One loan can buy some properties and refinance others, so the loan-level
   `comboLoanScenarioType` is never consulted. Contradicting it either way
   changes nothing. */
test("the loan-level scenario type changes nothing about the properties", async () => {
  for (const scenario of ["Refinance", "Acquisition"]) {
    const payload = await scrapePayload({
      fields: withFields({ comboLoanScenarioType: scenario }),
      grids: withGrids({ propertyRows: [acquisitionRow()] })
    });
    assert.deepEqual(
      payload.properties,
      [{ address: "1400 Ocean Avenue", transactionType: "Acquisition", purchasePrice: "$850,000" }],
      scenario
    );
  }
});

test("a mixed loan carries every property, in grid order", async () => {
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
    { address: "217 to 225 S. Harbor Boulevard", transactionType: "Refinance-Standard" },
    { address: "1400 Ocean Avenue", transactionType: "Acquisition", purchasePrice: "$850,000" },
    { address: "88 Palm Court", transactionType: "Acquisition", purchasePrice: "$1,200,000" }
  ]);
});

test("a property with no purchase price filled in leaves the price out", async () => {
  const payload = await scrapePayload({
    grids: withGrids({ propertyRows: [acquisitionRow({ price: "$0" })] })
  });
  assert.deepEqual(payload.properties, [{ address: "1400 Ocean Avenue", transactionType: "Acquisition" }]);
  assert.match(humperdinkNoteText(payload), /Properties\n1400 Ocean Avenue \(Acquisition\)$/);
});

/* AC: "Note sections read in a stable order alongside the terms from #196." */
test("the people lead the note and the properties close it, always in that order", async () => {
  const note = await scrapeNote(
    withFields({ txtLoanTermsNotes: "Rate locked 14 days." }),
    withGrids({ propertyRows: [acquisitionRow()] })
  );
  assert.deepEqual(
    note.split("\n\n").map((block) => block.split("\n")[0]),
    ["Contacts", "Loan Terms", "Loan Term Notes", "Properties"]
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
  assert.equal(page.loading, true);

  // Pressing while it waits copies nothing and says why.
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Still loading/);
  assert.deepEqual(page.fetched, [], "no property to fetch a release price for yet");

  page.loadGrids({ contactRows: CONTACT_ROWS, propertyRows: PROPERTY_ROWS });
  await settle();
  assert.equal(page.fetched.length, 1, "the release price is fetched once the property is in");
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
  assert.equal(page.loading, true);
});

test("a page whose grids are already painted stops saying Loading as soon as its release prices land", async () => {
  const page = runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL });
  await page.settled();
  assert.equal(page.loading, false);
  assert.equal(page.button.style.opacity, "", "not dimmed");
  assert.equal(page.button.textContent, "Export to HT");
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
  assert.equal(page.loading, true);
  await settle();
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /contenttableContactsGrid/);
});

test("a column the scrape needs going missing is reported by name", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    grids: withGrids({ propertyHeaders: PROPERTY_HEADERS.map((h) => (h.trim() === "Purchase  Price" ? "Price" : h)) })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Purchase Price column/);
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
  assert.equal(page.loading, false, "it stops claiming to be loading");
  assert.equal(page.button.style.opacity, "", "and stops looking dimmed");
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /hadn't finished loading/);
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
  assert.match(page.said, /contacts \(they hadn't finished loading\)/);
});

/* ── Copy, then open Hot Task in Teams desktop (#414) ─────

   The loan travels on the clipboard. Once the copy has landed, still inside the
   same press (Chrome launches an external protocol only on a user gesture), the
   control navigates to the Humperdink arrival link, which opens a new LOI Check
   in Teams desktop. The link carries no loan data. It replaced #198's new-tab
   https link, which detoured through Microsoft's launcher page, so these hold
   it to the `msteams:` form and to nothing opening when nothing was copied. */

const goodPage = (over = {}) => runUserscript({ title: "Adams - Harbor - Details", href: LOAN_URL, ...over });

/* The press tag the userscript put after the sentinel, or undefined. */
const pressTagOf = (href) => {
  const context = JSON.parse(decodeURIComponent(href.split("?context=")[1] ?? "{}"));
  return /^new:humperdink:(.+)$/.exec(context.subEntityId ?? "")?.[1];
};

test("one press copies the loan once, then opens Hot Task in Teams desktop", async () => {
  const page = goodPage();
  await page.press();
  assert.equal(page.copied.length, 1);
  assert.equal(JSON.parse(page.copied[0]).loanName, "Adams - Harbor");
  assert.equal(page.navigated.length, 1, "one navigation");
  assert.equal(page.navigated[0].copiesBefore, 1, "after the copy landed, not before");
  assert.match(page.navigated[0].href, /^msteams:\/l\/entity\//);
  assert.deepEqual(page.opened, [], "no new tab");
  assert.equal(page.said, COPIED);
});

test("the link it opens is the shared arrival link for the live install", async () => {
  // A drift in the sentinel, the entity id or the app id turns this red. The
  // manifest id is checked for being a real one, so a placeholder on both sides
  // can't pass it.
  assert.match(LIVE_MANIFEST.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const page = goodPage();
  await page.press();
  const href = page.navigated[0].href;
  assert.equal(href, humperdinkArrivalLink(LIVE_MANIFEST.id, pressTagOf(href)));
  assert.ok(href.includes(encodeURIComponent(HUMPERDINK_ARRIVAL_ID)));
});

/* Teams desktop ignores a deep link identical to the page it is showing, so a
   second press with Hot Task still on screen used to open nothing. */
test("every press opens its own link, so a second press reaches Hot Task already on screen", async () => {
  // No wait between the presses: two copies landing in the same millisecond
  // must still make two links (#436 review).
  const page = goodPage();
  await page.press();
  await page.press();
  assert.equal(page.navigated.length, 2);
  const [first, second] = page.navigated.map((n) => n.href);
  assert.notEqual(first, second);
  for (const href of [first, second]) {
    assert.match(pressTagOf(href), /^[0-9a-z]+$/, "the tag is only a timestamp");
    assert.equal(href, humperdinkArrivalLink(LIVE_MANIFEST.id, pressTagOf(href)));
  }
});

test("the link carries no loan data", async () => {
  const page = goodPage();
  await page.press();
  const link = decodeURIComponent(page.navigated[0].href);
  assert.doesNotMatch(link, /Adams|Harbor|335203|humperdink\.loneoakfund/);
});

test("a refused clipboard shows today's error and opens nothing", async () => {
  const page = goodPage({ clipboard: "dead" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Couldn't reach the clipboard\. Copy this page's URL by hand\./);
  assert.deepEqual(page.navigated, []);
  assert.deepEqual(page.opened, []);
});

test("a page it can't read opens nothing either", async () => {
  const page = goodPage({ title: "Loan Pipeline" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.navigated, []);
});

test("the execCommand fallback copies, then opens Hot Task the same way", async () => {
  const page = goodPage({ clipboard: "no-async-api" });
  await page.press();
  assert.equal(page.navigated.length, 1);
  assert.equal(page.navigated[0].copiesBefore, 1);
  assert.equal(page.navigated[0].href, humperdinkArrivalLink(LIVE_MANIFEST.id, pressTagOf(page.navigated[0].href)));
});

test("the script carries no teams.microsoft.com link and never opens a tab", () => {
  assert.doesNotMatch(USERSCRIPT, /teams\.microsoft\.com/);
  assert.doesNotMatch(USERSCRIPT, /window\.open/);
  assert.match(USERSCRIPT, /msteams:/);
  assert.ok(USERSCRIPT.includes(`"${LIVE_MANIFEST.id}"`), "the app id is written out as the live manifest's id");
});

/* The team installs and updates this script from loftools. A wrong or missing
   update address fails silently: nobody gets another version, ever. */
test("the script updates from its loftools address, with one version", () => {
  const header = USERSCRIPT.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)[1];
  const values = (key) => [...header.matchAll(new RegExp(`^//\\s*@${key}\\s+(.+?)\\s*$`, "gm"))].map((m) => m[1]);
  const address = "https://loftools.thepopcorn.party/userscripts/send-to-hot-task.user.js";
  assert.deepEqual(values("downloadURL"), [address]);
  assert.deepEqual(values("updateURL"), [address]);
  assert.equal(values("version").length, 1);
});

test("a second press copies and opens again", async () => {
  const page = goodPage();
  await page.press();
  await page.press();
  assert.equal(page.copied.length, 2);
  assert.equal(page.navigated.length, 2);
  assert.deepEqual(page.opened, []);
});

test("a press while the grids are still loading copies nothing", async () => {
  const page = goodPage({ grids: withGrids({ contactRows: [], propertyRows: [] }) });
  assert.equal(page.loading, true);
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Still loading/);
  assert.deepEqual(page.navigated, [], "and opens nothing");
});

/* ── Extensions, switches, the lender, release prices (#442) ──

   The ids, the switch markup and the values below were read off a live loan
   on 2026-09-15, once filled in and once with every panel switched off and
   emptied. */

const EXTENSION_ROW = {
  ExtensionMonthStart1: "1",
  ExtensionMonthEnd1: "6",
  ExtensionRate1: "8.90%",
  ExtensionPoints1: "1.00"
};

const headingsOf = (note) => note.split("\n\n").map((block) => block.split("\n")[0]);
const sectionOf = (note, heading) => note.split("\n\n").find((block) => block.split("\n")[0] === heading);

test("an extension row travels as a line in its own block, right after Loan Terms", async () => {
  const switches = withSwitches({ extensions: true });
  const terms = await scrapeTerms(withFields(EXTENSION_ROW), switches);
  assert.deepEqual(terms.extensions, [{ startMonth: "1", endMonth: "6", rate: "8.90%", points: "1.00" }]);

  const note = await scrapeNote(withFields({ ...EXTENSION_ROW, txtLoanTermsNotes: "Rate locked 14 days." }), withGrids(), switches);
  assert.deepEqual(headingsOf(note), ["Contacts", "Loan Terms", "Extensions", "Loan Term Notes", "Properties"]);
  assert.equal(sectionOf(note, "Extensions"), "Extensions\nMonths 1–6 at 8.90%, 1.00 points");
});

test("every extension row travels in row order, a missing % is added and zero points are left off", async () => {
  const note = await scrapeNote(
    withFields({
      ...EXTENSION_ROW,
      ExtensionMonthStart2: "7",
      ExtensionMonthEnd2: "12",
      ExtensionRate2: "9.40",
      ExtensionPoints2: "0.00"
    }),
    withGrids(),
    withSwitches({ extensions: true })
  );
  assert.equal(sectionOf(note, "Extensions"), "Extensions\nMonths 1–6 at 8.90%, 1.00 points\nMonths 7–12 at 9.40%");
});

test("the extension notes follow the extension lines", async () => {
  const note = await scrapeNote(
    withFields({ ...EXTENSION_ROW, extensionstextarea: "Fee due at each extension." }),
    withGrids(),
    withSwitches({ extensions: true })
  );
  assert.equal(
    sectionOf(note, "Extensions"),
    "Extensions\nMonths 1–6 at 8.90%, 1.00 points\nFee due at each extension."
  );
});

/* A loan with no extensions has no row elements at all, so a missing row 1 is
   an ordinary loan, not a Humperdink change. */
test("a loan with no extension rows exports cleanly, with no Extensions block either way its switch sits", async () => {
  for (const extensions of [true, false]) {
    const note = await scrapeNote(TERMS_FIELDS, withGrids(), withSwitches({ extensions }));
    assert.equal(sectionOf(note, "Extensions"), undefined, `switch ${extensions ? "on" : "off"}`);
  }
});

test("a page missing the extension notes box reports it and copies nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    fields: withFields({ extensionstextarea: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /extensionstextarea/);
});

/* The live off state: every panel switched off, figures still in its inputs. */
const STALE_FIELDS = withFields({
  ...EXTENSION_ROW,
  extensionstextarea: "Old extension note.",
  JuniorFinancingAmount: "$200,000.00",
  SecondTDRate: "9.90%",
  SecondTDFeePoints: "1",
  SecondTDFeeAmount: "$2,000.00",
  SellerFinancingAmount: "$500,000.00",
  InitialDisbursed: "$1,000,000",
  DrawMinimumAmount: "$10,000",
  DrawIncrementAmount: "$10,000",
  interestReserveAmount: "$150,000.00",
  interestReserveMonths: "12",
  txtpartialReconveyance: "125% of allocated loan amount"
});

test("a switched-off panel sends nothing, whatever its inputs still hold", async () => {
  const note = await scrapeNote(STALE_FIELDS, withGrids(), SWITCHES_OFF);
  assert.deepEqual(headingsOf(note), ["Contacts", "Loan Terms", "Properties"]);
  assert.doesNotMatch(note, /\$10,000|Permitted|Old extension note/);
});

test("the same inputs with every switch on all travel", async () => {
  const note = await scrapeNote(STALE_FIELDS, withGrids(), SWITCHES_ON);
  assert.deepEqual(headingsOf(note), [
    "Contacts",
    "Loan Terms",
    "Extensions",
    "Junior Financing",
    "Blended Totals",
    "Seller Financing",
    "Disbursement Options",
    "Interest Reserve",
    "Partial Reconveyance",
    "Properties"
  ]);
});

test("one panel switched on travels while the rest stay behind", async () => {
  const note = await scrapeNote(STALE_FIELDS, withGrids(), withSwitches({ disbursement: true }));
  assert.deepEqual(headingsOf(note), ["Contacts", "Loan Terms", "Disbursement Options", "Properties"]);
  assert.equal(
    sectionOf(note, "Disbursement Options"),
    "Disbursement Options\nInitial Advance: $1,000,000\nDraw Minimum: $10,000\nIncrement: $10,000"
  );
});

test("a page missing a panel switch reports it by id and copies nothing", async () => {
  const page = runUserscript({
    title: "Adams - Harbor - Details",
    href: LOAN_URL,
    switches: withSwitches({ disbursement: null })
  });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /toggleHoldBack/);
});

test("financing switched on with nothing filled in says Permitted, and nothing more", async () => {
  const note = await scrapeNote(TERMS_FIELDS, withGrids(), withSwitches({ juniorFinancing: true, sellerFinancing: true }));
  assert.equal(sectionOf(note, "Junior Financing"), "Junior Financing\nJunior Financing: Permitted");
  assert.equal(sectionOf(note, "Seller Financing"), "Seller Financing\nSeller Financing: Permitted");
  assert.equal(sectionOf(note, "Blended Totals"), undefined, "the blended figures still need a junior loan");
});

test("financing with figures shows the figures, not Permitted", async () => {
  const note = await scrapeNote(
    withFields({ SellerFinancingAmount: "$500,000.00" }),
    withGrids(),
    withSwitches({ sellerFinancing: true })
  );
  assert.equal(sectionOf(note, "Seller Financing"), "Seller Financing\nAmount: $500,000.00");
});

test("a Lender contact travels, after the borrowers", async () => {
  const rows = [
    ["", "", "Lender", "RTI Properties", "", "", "", "", ""],
    ...CONTACT_ROWS,
    ["", "", "Silent Borrower", "Pat Quiet", "", "", "", "", ""]
  ];
  const payload = await scrapePayload({ grids: withGrids({ contactRows: rows }) });
  assert.deepEqual(payload.contacts, [
    { type: "Broker", name: "Dan LuVisi" },
    { type: "Borrower", name: "Duda Adams" },
    { type: "Silent Borrower", name: "Pat Quiet" },
    { type: "Lender", name: "RTI Properties" }
  ]);
  assert.equal(sectionOf(humperdinkNoteText(payload), "Contacts").split("\n").pop(), "Lender: RTI Properties");
});

const OCEAN = "1400 Ocean Avenue";

test("a property's release price travels, as dollars", async () => {
  const payload = await scrapePayload({
    grids: withGrids({ propertyRows: [acquisitionRow()] }),
    releasePrices: { [OCEAN]: "2950000.00" }
  });
  assert.deepEqual(payload.properties, [
    { address: OCEAN, transactionType: "Acquisition", purchasePrice: "$850,000", releasePrice: "$2,950,000.00" }
  ]);
  assert.equal(
    sectionOf(humperdinkNoteText(payload), "Properties"),
    "Properties\n1400 Ocean Avenue (Acquisition), Purchase Price $850,000, Release Price $2,950,000.00"
  );
});

test("a blank or zero release price is left out", async () => {
  for (const price of ["", "0.00"]) {
    const payload = await scrapePayload({
      grids: withGrids({ propertyRows: [acquisitionRow()] }),
      releasePrices: { [OCEAN]: price }
    });
    assert.equal("releasePrice" in payload.properties[0], false, JSON.stringify(price));
  }
});

test("each property gets its own release price", async () => {
  const payload = await scrapePayload({
    grids: withGrids({
      propertyRows: [acquisitionRow(), acquisitionRow({ address: "88 Palm Court, <br>Irvine, CA 92602", price: "$1,200,000" })]
    }),
    releasePrices: { [OCEAN]: "2950000.00", "88 Palm Court": "1100000" }
  });
  assert.deepEqual(
    payload.properties.map((property) => property.releasePrice),
    ["$2,950,000.00", "$1,100,000"]
  );
});

/* A clipboard write and the Teams launch both have to happen inside the press,
   so the network is done with before anyone presses. */
test("release prices are fetched once, as the page loads, and never during the press", async () => {
  const page = goodPage({ grids: withGrids({ propertyRows: [acquisitionRow()] }), releasePrices: { [OCEAN]: "2950000.00" } });
  await page.settled();
  assert.equal(page.loading, false);
  assert.equal(page.fetched.length, 1);
  const [request] = page.fetched;
  assert.match(request.href, /^\/Loans\/NewPropertyPartial\?/);
  const query = new URL(request.href, LOAN_URL).searchParams;
  assert.equal(query.get("isNewProperty"), "false");
  assert.equal(query.get("pkpropertyid"), "7000");
  assert.equal(query.get("pkloanspropertydetails"), "9000");
  assert.equal(request.credentials, "same-origin");

  await page.press();
  assert.equal(page.fetched.length, 1, "the press copies what already loaded");
  assert.equal(page.copied.length, 1);
  assert.equal(page.navigated[0].copiesBefore, 1);
});

test("the control reads Loading until the release prices land", async () => {
  const page = goodPage({ releaseFetch: "hang" });
  await page.settled();
  assert.equal(page.loading, true);
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /Still loading/);
  assert.deepEqual(page.navigated, []);
});

test("release prices that never land are reported once the control gives up waiting", async () => {
  const page = goodPage({ releaseFetch: "hang", clockScale: 200 });
  await settle();
  assert.equal(page.loading, false);
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /release prices \(they hadn't finished loading\)/);
});

test("a release-price fetch Humperdink refuses is reported and nothing is copied", async () => {
  const page = goodPage({ releaseFetch: "fail" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /release price for 217 to 225 S\. Harbor Boulevard \(Humperdink answered 500\)/);
});

test("property details with no release price field are reported by id", async () => {
  const page = goodPage({ releaseFetch: "no-input" });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /txtReleasePrice/);
});

test("a property added after the page loaded is reported, not exported without its release price", async () => {
  const page = goodPage();
  await page.settled();
  page.loadGrids({ propertyRows: [...PROPERTY_ROWS, acquisitionRow()] });
  await page.press();
  assert.deepEqual(page.copied, []);
  assert.match(page.said, /release price for 1400 Ocean Avenue/);
});

/* An edit made in Humperdink's property window after the page loaded, or a
   property added, is picked up when the pointer reaches the control, and the
   press still never waits on the network. */
test("hovering the control re-fetches the release prices, so a later edit or a new property exports", async () => {
  const prices = { [OCEAN]: "900000" };
  const page = goodPage({ grids: withGrids({ propertyRows: [acquisitionRow()] }), releasePrices: prices });
  await page.settled();
  prices[OCEAN] = "950000";
  prices["88 Palm Court"] = "400000";
  page.loadGrids({ propertyRows: [acquisitionRow(), acquisitionRow({ address: "88 Palm Court, <br>Irvine, CA 92602" })] });
  page.hover();
  await page.press();
  assert.equal(page.copied.length, 1, page.said);
  assert.deepEqual(
    JSON.parse(page.copied[0]).properties.map((property) => property.releasePrice),
    ["$950,000", "$400,000"]
  );
  assert.equal(page.fetched.length, 3, "one on load, two on the hover");
});

/* Grids that land after the twenty-second ceiling used to be read on the press;
   their release prices must still get fetched. */
test("grids that land after the control stopped waiting still get their release prices, and export", async () => {
  const page = goodPage({ grids: withGrids({ contactRows: [], propertyRows: [] }), clockScale: 200 });
  await settle();
  assert.equal(page.loading, false, "it gave up waiting");
  page.loadGrids({ contactRows: CONTACT_ROWS, propertyRows: [acquisitionRow()] });
  await settle();
  assert.equal(page.fetched.length, 1);
  await page.press();
  assert.equal(page.copied.length, 1, page.said);
});

test("two properties on one street in different towns keep their own release prices, whatever order the grid data is in", async () => {
  const payload = await scrapePayload({
    grids: withGrids({
      propertyRows: [
        acquisitionRow({ address: "100 Main Street, <br>Irvine, CA 92602" }),
        acquisitionRow({ address: "100 Main Street, <br>Tustin, CA 92780" })
      ]
    }),
    releasePrices: { "100 Main Street, Irvine, CA 92602": "1000000", "100 Main Street, Tustin, CA 92780": "2000000" },
    propertyDataOrder: "reversed"
  });
  assert.deepEqual(
    payload.properties.map((property) => property.releasePrice),
    ["$1,000,000", "$2,000,000"]
  );
});

/* The painted cell escapes `&` and the grid's data doesn't. */
test("an address with an ampersand reads as one and still finds its release price", async () => {
  const payload = await scrapePayload({
    grids: withGrids({ propertyRows: [acquisitionRow({ address: "12 Oak &amp; Elm Street, <br>Irvine, CA 92602" })] }),
    releasePrices: { "12 Oak & Elm Street": "750000" }
  });
  assert.equal(payload.properties[0].address, "12 Oak & Elm Street");
  assert.equal(payload.properties[0].releasePrice, "$750,000");
});

/* ── What the parser will accept for #442 ── */

test("the parser rebuilds extension rows, drops empty ones and caps a runaway table", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ startMonth: String(i + 1), endMonth: "x", rate: "1%", points: "1" }));
  const result = withTerms({ extensions: [{ startMonth: "", endMonth: "", rate: "", points: "" }, ...rows, "not a row", null] });
  assert.equal(result.payload.terms.extensions.length, 12);
  assert.deepEqual(result.payload.terms.extensions[0], { startMonth: "1", endMonth: "x", rate: "1%", points: "1" });
});

test("extension notes alone still make an Extensions block", () => {
  const result = withTerms({ extensionNotes: "Two six-month options." });
  assert.equal(humperdinkNoteText(result.payload), "Extensions\nTwo six-month options.");
});

test("the parser keeps a property's transaction type and release price", () => {
  const result = parseHumperdinkPayload(
    payloadText({
      properties: [{ address: "12 Elm St", transactionType: "Refinance-Standard", releasePrice: "$1", purchasePrice: 7 }]
    })
  );
  assert.deepEqual(result.payload.properties, [
    { address: "12 Elm St", transactionType: "Refinance-Standard", releasePrice: "$1" }
  ]);
});

/* An older script sends acquisitions with neither a transaction type nor a
   release price. */
test("a property from an older script still reads as one line", () => {
  const result = parseHumperdinkPayload(payloadText({ properties: [{ address: OCEAN, purchasePrice: "$850,000" }] }));
  assert.equal(humperdinkNoteText(result.payload), "Properties\n1400 Ocean Avenue, Purchase Price $850,000");
});

/* Every property travelling changed what `properties` means, so the version
   went to 2: an app that only reads 1 refuses the export and says to update,
   rather than printing refinances as acquisitions. A version 1 export from a
   script that hasn't updated yet still reads. */
test("the payload is version 2, and a version 1 export from an older script still reads", () => {
  assert.equal(HUMPERDINK_PAYLOAD_VERSION, 2);
  assert.equal(SUPPORTED_HUMPERDINK_PAYLOAD_VERSION, 2);
  const result = parseHumperdinkPayload(
    payloadText({ version: 1, properties: [{ address: OCEAN, purchasePrice: "$850,000" }] })
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.payload.version, 1);
  assert.equal(result.payload.properties.length, 1);
});
