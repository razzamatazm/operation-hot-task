// ==UserScript==
// @name         Send to Hot Task
// @namespace    https://github.com/razzamatazm/operation-hot-task
// @version      1.1.0
// @description  Copy a Humperdink loan to the clipboard so Hot Task's create form can take it.
// @author       Operation Hot Task
// @match        https://humperdink.loneoakfund.com/Loans/Details/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* See README.md beside this file for install instructions and for why this is
   self-installed rather than centrally deployed.

   The payload shape is the contract in packages/shared/src/humperdink.ts —
   `HumperdinkPayload` there, `parseHumperdinkPayload` reads what this writes.
   The constants below are duplicated deliberately: a userscript is a classic
   script pasted into Tampermonkey, so it cannot import from the workspace.
   `scripts/humperdink-import-sim-test.mjs` runs THIS FILE against that parser,
   so the copy can't drift without a test going red.

   The loan name comes off the page title and the link off the address bar,
   both of which survive Humperdink reshuffling its markup. The loan terms
   (#196) are read by element id, which is the part that needs maintaining
   against the real page — a missing id is reported rather than skipped, so a
   Humperdink release that renames one shows up as a refused copy and not as a
   note with a hole in it. */

(function () {
  "use strict";

  /* Contract — keep in sync with packages/shared/src/humperdink.ts. */
  var PAYLOAD_KIND = "hot-task-humperdink";
  var PAYLOAD_VERSION = 1;
  var TITLE_SUFFIX = " - details";
  var LOAN_DETAILS_PATH = /^\/Loans\/Details\/[^/]+\/?$/i;

  var BUTTON_ID = "hot-task-send-control";
  var IDLE_LABEL = "Send to Hot Task";
  var MESSAGE_MS = 6000;

  /* Humperdink titles the page `<LoanName> - Details`. The name is written into
     the page by its own JavaScript after load and has no stable element of its
     own, so the title is the reliable source. */
  function loanNameFromTitle(title) {
    var text = String(title == null ? "" : title).trim();
    if (text.toLowerCase().slice(-TITLE_SUFFIX.length) !== TITLE_SUFFIX) return "";
    return text.slice(0, text.length - TITLE_SUFFIX.length).trim();
  }

  /* Origin + path only, or "" when this isn't a loan details page. Humperdink's
     details URLs are path-only in practice, and dropping any query/hash keeps
     the link stable as the canonical key for a Loan on the Hot Task side
     (ADR-0001) — otherwise a visit that happened to carry a tracking param
     would mint a second loan. The same three gates the Hot Task parser applies
     (parses, http(s), whole path is a details path). */
  function loanUrlFrom(location) {
    try {
      var url = new URL(String(location && location.href ? location.href : ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      if (!LOAN_DETAILS_PATH.test(url.pathname)) return "";
      return url.origin + url.pathname;
    } catch (err) {
      return "";
    }
  }

  /* ── The loan terms panel (#196) ──────────────────────────

     Where the id-based scraping starts. Every field below is a server-rendered
     `<input>` or `<textarea>` in Humperdink's Loan Terms panel and its
     neighbouring toggle panels, read by id. Ids are Humperdink's own and are
     the most stable handle the page offers — far steadier than the nested
     tables and jqxWidget wrappers around them — but they are still Humperdink's
     to change, which is why a missing one is reported rather than skipped.

     Deliberately NOT read, per #196: loan-amount-requested, term-requested,
     reason for loan, exit strategy, borrower real estate experience, red flags,
     lender, status, closing date. */

  /* Core terms. Their elements must exist; their values may be empty. */
  var CORE_TERM_IDS = {
    loanAmount: "loanAmount",
    totalValue: "totalLoanValue",
    ltv: "LTV",
    termMonths: "LoanTerm",
    originationFeePoints: "OriginationFeePoints",
    brokerFeePoints: "BrokerFeePoints",
    evaluationFee: "txtEvaluation",
    loanTermNotes: "txtLoanTermsNotes"
  };

  /* The first interest rate row is core too; further rows are however many the
     loan has, so they are read until they run out. */
  var RATE_TIER_IDS = ["RateMonthStart", "RateMonthEnd", "InterestRate"];
  var MAX_RATE_TIERS = 12;

  /* Conditional terms: panels Humperdink keeps collapsed until a loan uses
     them. Their elements exist on every page, filled or not — which is why the
     test for including them is the VALUE, not the element. */
  var JUNIOR_TERM_IDS = {
    juniorFinancingAmount: "JuniorFinancingAmount",
    juniorFinancingRate: "SecondTDRate",
    juniorFinancingPoints: "SecondTDFeePoints",
    juniorFinancingFee: "SecondTDFeeAmount"
  };

  /* Combined and blended figures are computed from the junior loan, so
     Humperdink fills them on every page whether or not there is one — on a loan
     with no junior financing they just restate the core terms. They travel only
     alongside a junior loan that actually exists; otherwise the note would
     carry the same numbers twice under a heading that means nothing. */
  var BLENDED_TERM_IDS = {
    combinedLoanAndCltv: "CombinedLoanAmount_LTV",
    blendedRate: "BlendedRate",
    blendedPoints: "BlendedFeePoints",
    blendedFee: "BlendedFeeAmount"
  };

  var OTHER_CONDITIONAL_TERM_IDS = {
    sellerFinancingAmount: "SellerFinancingAmount",
    initialAdvance: "InitialDisbursed",
    drawMinimum: "DrawMinimumAmount",
    drawIncrement: "DrawIncrementAmount",
    interestReserveAmount: "interestReserveAmount",
    interestReserveMonths: "interestReserveMonths",
    partialReconveyance: "txtpartialReconveyance"
  };

  /* A field's displayed text, trimmed. */
  function fieldValue(el) {
    if (!el) return "";
    return String(el.value == null ? "" : el.value).trim();
  }

  /* The same, but with zero counting as nothing — for the conditional panels
     only.

     Humperdink pre-fills the panels a loan isn't using with `0.00%` and `$0.00`
     rather than leaving them blank, so a plain "is it empty" test would put
     `Junior Financing / Rate: 0.00%` in the note of every loan that has no
     junior financing — exactly the wall of empty labels #196 rules out.

     The core terms deliberately do NOT get this treatment. A Broker Fee of 0
     points is an ordinary loan with no broker, and `Broker Fee: 0 points` is
     the note saying so; dropping the line would leave the reader unable to tell
     that from a field this script failed to read. */
  function optionalFieldValue(el) {
    var raw = fieldValue(el);
    if (!raw) return "";
    var asNumber = Number(raw.replace(/[$,%\s]/g, ""));
    if (!isNaN(asNumber) && asNumber === 0) return "";
    return raw;
  }

  /* Read a conditional group by id, keeping only the ones holding a value. */
  function readGroup(doc, ids) {
    var out = {};
    for (var key in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, key)) continue;
      var value = optionalFieldValue(doc.getElementById(ids[key]));
      if (value) out[key] = value;
    }
    return out;
  }

  function assign(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  function hasAny(group) {
    for (var key in group) {
      if (Object.prototype.hasOwnProperty.call(group, key)) return true;
    }
    return false;
  }

  /* Rows of the interest rate table, read until the ids run out. Humperdink's
     table has an Add button and no fixed size, so a stepped loan can have any
     number of them; row 1 is the one every loan has. */
  function readRateTiers(doc) {
    var tiers = [];
    for (var row = 1; row <= MAX_RATE_TIERS; row += 1) {
      var start = doc.getElementById(RATE_TIER_IDS[0] + row);
      var end = doc.getElementById(RATE_TIER_IDS[1] + row);
      var rate = doc.getElementById(RATE_TIER_IDS[2] + row);
      if (!start && !end && !rate) break;
      var tier = {
        startMonth: fieldValue(start),
        endMonth: fieldValue(end),
        rate: fieldValue(rate)
      };
      if (tier.startMonth || tier.endMonth || tier.rate) tiers.push(tier);
    }
    return tiers;
  }

  /* Scrape the terms, or list the ids the page didn't have.

     The two halves are different failures on purpose. A core field whose
     ELEMENT is gone means Humperdink moved something and this script needs
     maintaining — reported, so nobody imports a note with a silent hole in it.
     A field whose element is there and empty is just a loan that doesn't use
     it, and is dropped without comment. */
  function collectTerms(doc) {
    var missingIds = [];
    var terms = {};
    for (var key in CORE_TERM_IDS) {
      if (!Object.prototype.hasOwnProperty.call(CORE_TERM_IDS, key)) continue;
      var id = CORE_TERM_IDS[key];
      var el = doc.getElementById(id);
      if (!el) {
        missingIds.push(id);
        continue;
      }
      var value = fieldValue(el);
      if (value) terms[key] = value;
    }

    for (var i = 0; i < RATE_TIER_IDS.length; i += 1) {
      if (!doc.getElementById(RATE_TIER_IDS[i] + "1")) missingIds.push(RATE_TIER_IDS[i] + "1");
    }
    var tiers = readRateTiers(doc);
    if (tiers.length > 0) terms.rateTiers = tiers;

    var junior = readGroup(doc, JUNIOR_TERM_IDS);
    assign(terms, junior);
    if (hasAny(junior)) assign(terms, readGroup(doc, BLENDED_TERM_IDS));
    assign(terms, readGroup(doc, OTHER_CONDITIONAL_TERM_IDS));

    if (missingIds.length > 0) return { ok: false, missingIds: missingIds };
    return { ok: true, terms: terms };
  }

  /* Build the payload, or say what's missing. Never returns a partial payload:
     a half-filled create form is worse than no import, because the filer has no
     way to tell which half is wrong. */
  function collect(doc, location) {
    var missing = [];
    var loanName = loanNameFromTitle(doc.title);
    if (!loanName) missing.push('the loan name (the page title should read "<loan> - Details")');
    var loanUrl = loanUrlFrom(location);
    if (!loanUrl) missing.push("the loan details URL");
    var terms = collectTerms(doc);
    if (!terms.ok) {
      missing.push("the loan terms (this page has no " + terms.missingIds.join(", ") + " field)");
    }
    if (missing.length > 0) {
      return { ok: false, error: "Couldn't read " + missing.join(" or ") + "." };
    }
    return {
      ok: true,
      payload: {
        kind: PAYLOAD_KIND,
        version: PAYLOAD_VERSION,
        loanName: loanName,
        loanUrl: loanUrl,
        terms: terms.terms
      }
    };
  }

  /* Async clipboard first; `document.execCommand` when it isn't there or is
     refused. Humperdink runs in whatever browser the desk has, and a copy that
     silently no-ops would look identical to a successful one. */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.left = "-9999px";
      document.body.appendChild(scratch);
      scratch.select();
      var copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (err) {
        copied = false;
      }
      document.body.removeChild(scratch);
      if (copied) resolve();
      else reject(new Error("copy refused"));
    });
  }

  function mount() {
    if (document.getElementById(BUTTON_ID)) return;

    var button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = IDLE_LABEL;
    /* Floating rather than injected into Humperdink's own chrome: anchoring to
       a page element would make the control disappear the next time Humperdink
       reshuffles its markup, and a missing button is a silent failure. */
    button.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:320px",
      "padding:9px 14px",
      "border:1px solid #1f1f1f",
      "border-radius:6px",
      "background:#1f1f1f",
      "color:#fff",
      "font:600 13px/1.35 system-ui,sans-serif",
      "text-align:left",
      "cursor:pointer",
      "box-shadow:0 2px 8px rgba(0,0,0,0.25)"
    ].join(";");

    var resetTimer = 0;
    function say(message) {
      button.textContent = message;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(function () {
        button.textContent = IDLE_LABEL;
        resetTimer = 0;
      }, MESSAGE_MS);
    }

    button.addEventListener("click", function () {
      var result = collect(document, location);
      if (!result.ok) {
        say(result.error);
        return;
      }
      var text = JSON.stringify(result.payload);
      copyText(text).then(
        function () {
          say("Copied — paste it into Hot Task");
        },
        function () {
          say("Couldn't reach the clipboard. Copy this page's URL by hand.");
        }
      );
    });

    document.body.appendChild(button);
  }

  mount();
})();
