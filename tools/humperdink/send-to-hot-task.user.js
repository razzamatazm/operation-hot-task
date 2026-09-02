// ==UserScript==
// @name         Send to Hot Task
// @namespace    https://github.com/razzamatazm/operation-hot-task
// @version      1.0.0
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

   Nothing here is scraped by CSS selector. The loan name comes off the page
   title and the link off the address bar, both of which survive Humperdink
   reshuffling its markup. Later tickets (#196, #197) add id-based scraping and
   will need this file maintained against the real page. */

(function () {
  "use strict";

  /* Contract — keep in sync with packages/shared/src/humperdink.ts. */
  var PAYLOAD_KIND = "hot-task-humperdink";
  var PAYLOAD_VERSION = 1;
  var TITLE_SUFFIX = " - details";
  var LOAN_DETAILS_PATH = /\/Loans\/Details\/[^/?#]+/i;

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

  /* Origin + path only. Humperdink's details URLs are path-only in practice,
     and dropping any query/hash keeps the link stable as the canonical key for
     a Loan on the Hot Task side (ADR-0001) — otherwise a visit that happened to
     carry a tracking param would mint a second loan. */
  function loanUrlFrom(location) {
    var href = String(location && location.href ? location.href : "");
    var origin = String(location && location.origin ? location.origin : "");
    var pathname = String(location && location.pathname ? location.pathname : "");
    return origin && pathname ? origin + pathname : href.split("#")[0].split("?")[0];
  }

  /* Build the payload, or say what's missing. Never returns a partial payload:
     a half-filled create form is worse than no import, because the filer has no
     way to tell which half is wrong. */
  function collect(doc, location) {
    var missing = [];
    var loanName = loanNameFromTitle(doc.title);
    if (!loanName) missing.push('the loan name (the page title should read "<loan> - Details")');
    var loanUrl = loanUrlFrom(location);
    if (!LOAN_DETAILS_PATH.test(loanUrl)) missing.push("the loan details URL");
    if (missing.length > 0) {
      return { ok: false, error: "Couldn't read " + missing.join(" or ") + "." };
    }
    return {
      ok: true,
      payload: { kind: PAYLOAD_KIND, version: PAYLOAD_VERSION, loanName: loanName, loanUrl: loanUrl }
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
