// ==UserScript==
// @name         Send to Hot Task
// @namespace    https://github.com/razzamatazm/operation-hot-task
// @version      1.3.0
// @description  Copy a Humperdink loan to the clipboard and open Hot Task's create form for the paste.
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
   note with a hole in it.

   The contacts and properties (#197) are not in the page's HTML at all —
   Humperdink fetches them after render — so the control waits for them and
   reads `Loading…` until they arrive. They are matched on header and contact
   type TEXT rather than on row or column position, because Humperdink's row ids
   are positional and would point at the wrong person the first time somebody
   adds a contact. */

(function () {
  "use strict";

  /* Contract — keep in sync with packages/shared/src/humperdink.ts. */
  var PAYLOAD_KIND = "hot-task-humperdink";
  var PAYLOAD_VERSION = 1;
  var TITLE_SUFFIX = " - details";
  var LOAN_DETAILS_PATH = /^\/Loans\/Details\/[^/]+\/?$/i;

  /* ── Where Hot Task lives (#198) ──────────────────────────

     Your Teams app id for Hot Task, so the control can land you on the create
     form after it copies. The one thing here you have to fill in; the README
     beside this file says where to find it.

     Leave it blank and the control behaves exactly as it did before — it
     copies, says so, and you go to Hot Task yourself. This is convenience, not
     capability: the paste is what carries the loan, and it works from a create
     form opened by any route. That mirrors `teamsTaskDeepLink` in
     packages/shared, which returns no link at all when it has no app id rather
     than emitting a broken one. */
  var HOT_TASK_APP_ID = "";

  /* Keep in sync with packages/shared/src/deep-link.ts. The link carries no
     data — the loan is on the clipboard — so all it says is "open the create
     form", in its own opt-in field of the `context` JSON. */
  var HOT_TASK_ENTITY_ID = "loan-tasks-home";
  var CREATE_FORM_INTENT_FIELD = "openCreateForm";

  function hotTaskCreateFormLink() {
    var appId = HOT_TASK_APP_ID.trim();
    if (!appId) return "";
    var context = {};
    context[CREATE_FORM_INTENT_FIELD] = true;
    return (
      "https://teams.microsoft.com/l/entity/" +
      appId +
      "/" +
      HOT_TASK_ENTITY_ID +
      "?context=" +
      encodeURIComponent(JSON.stringify(context))
    );
  }

  var BUTTON_ID = "hot-task-send-control";
  var IDLE_LABEL = "Send to Hot Task";
  var LOADING_LABEL = "Loading…";
  var MESSAGE_MS = 6000;
  /* How often to check whether Humperdink's background grids have painted, and
     how long to keep checking before giving up and letting the press report it
     (#197). */
  var POLL_MS = 250;
  var LOAD_CEILING_MS = 20000;

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
  function optionalValue(raw) {
    if (!raw) return "";
    var asNumber = Number(raw.replace(/[$,%\s]/g, ""));
    if (!isNaN(asNumber) && asNumber === 0) return "";
    return raw;
  }

  function optionalFieldValue(el) {
    return optionalValue(fieldValue(el));
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

  /* ── The contact and property grids (#197) ────────────────

     Unlike the terms, these two are not in the server HTML at all: Humperdink
     fetches them after the page renders and paints them into jqxGrids. So the
     control cannot simply read them on click — it waits for them (see
     `watchForGrids` below) and only then offers to copy.

     Each grid is two aligned tables: a header row of `[role=columnheader]`
     cells and a body of `[role=row]`s whose `[role=gridcell]`s sit in the same
     column order. Everything below is found by matching the HEADER TEXT and
     then reading the cell at that index. Nothing here counts rows or columns
     from a fixed position: Humperdink's row ids are literally positional
     (`row0ContactsGrid`), so a scrape built on them points at the wrong person
     the first time somebody adds a contact. */

  var CONTACTS_GRID = {
    what: "the loan's contacts",
    columnsId: "columntableContactsGrid",
    rowsId: "contenttableContactsGrid"
  };
  var PROPERTIES_GRID = {
    what: "the loan's properties",
    columnsId: "columntablePropertiesGrid",
    rowsId: "contenttablePropertiesGrid"
  };

  /* The contact types an LOI check needs, in the order they read in the note.
     Matched whole, case-insensitively, against the Type cell's text — a loan's
     other contacts (Escrow, Title) stay in Humperdink. */
  var CONTACT_TYPES = ["Broker", "Borrower"];

  /* Humperdink's transaction types read `Acquisition`, `Acquisition with Refi
     Cross`, `Refinance-Standard` and so on. Anything that calls itself an
     acquisition or a purchase counts, which is what "an acquisition of any
     kind" means. Note the loan-level scenario type (`comboLoanScenarioType`) is
     deliberately never consulted: one loan can buy some properties and
     refinance others, and #197 makes the per-property signal authoritative. */
  var ACQUISITION = /acquisition|purchase/i;

  function normalise(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  function elementText(el) {
    return el ? normalise(el.textContent) : "";
  }

  /* Humperdink packs a property's whole address into one cell, `<br/>`-split
     into street / city-state-zip / county. #197 wants the street line only. */
  function streetAddress(cell) {
    if (!cell) return "";
    var markup = cell.innerHTML == null ? "" : String(cell.innerHTML);
    var head = markup ? markup.split(/<br\s*\/?>/i)[0].replace(/<[^>]*>/g, "") : elementText(cell);
    return normalise(head).replace(/,+$/, "");
  }

  function gridRows(doc, grid) {
    var body = doc.getElementById(grid.rowsId);
    if (!body) return null;
    return body.querySelectorAll('[role="row"]');
  }

  /* The index of the column with this header, or -1. */
  function columnIndex(doc, grid, header) {
    var head = doc.getElementById(grid.columnsId);
    if (!head) return -1;
    var columns = head.querySelectorAll('[role="columnheader"]');
    var wanted = normalise(header).toLowerCase();
    for (var i = 0; i < columns.length; i += 1) {
      if (elementText(columns[i]).toLowerCase() === wanted) return i;
    }
    return -1;
  }

  /* Both grids have painted at least one row.

     An empty grid and a missing one are both "not here yet" while the control
     is waiting, because from in here they look the same: Humperdink builds
     these widgets and fills them as its background requests land, and there is
     no positive "loaded, and there are none" signal to read. The wait has a
     ceiling (`LOAD_CEILING_MS`), and past it the press reports whichever of the
     two it actually is — see `readGrid`. */
  function gridsSettled(doc) {
    var contacts = gridRows(doc, CONTACTS_GRID);
    var properties = gridRows(doc, PROPERTIES_GRID);
    return !!(contacts && contacts.length > 0 && properties && properties.length > 0);
  }

  /* Read a grid, or say what about it couldn't be read.

     Three separate failures, all reported rather than skipped: the grid's
     element is gone, the grid never loaded, or a column this scrape needs isn't
     in its header row. All three mean the note would have a hole in it. */
  function readGrid(doc, grid, headers) {
    var rows = gridRows(doc, grid);
    if (!rows) return { ok: false, error: grid.what + " (this page has no " + grid.rowsId + ")" };
    if (rows.length === 0) return { ok: false, error: grid.what + " (they hadn't finished loading)" };
    var indexes = {};
    var missingColumns = [];
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      var at = columnIndex(doc, grid, headers[key]);
      if (at < 0) missingColumns.push(headers[key]);
      else indexes[key] = at;
    }
    if (missingColumns.length > 0) {
      return { ok: false, error: grid.what + " (no " + missingColumns.join(" or ") + " column)" };
    }
    var read = [];
    for (var i = 0; i < rows.length; i += 1) {
      read.push(rows[i].querySelectorAll('[role="gridcell"]'));
    }
    return { ok: true, rows: read, at: indexes };
  }

  /* Broker and borrower, matched on the contact type text. */
  function collectContacts(doc) {
    var grid = readGrid(doc, CONTACTS_GRID, { type: "Type", name: "Name" });
    if (!grid.ok) return grid;
    var contacts = [];
    for (var t = 0; t < CONTACT_TYPES.length; t += 1) {
      var wanted = CONTACT_TYPES[t].toLowerCase();
      for (var i = 0; i < grid.rows.length; i += 1) {
        var cells = grid.rows[i];
        if (elementText(cells[grid.at.type]).toLowerCase() !== wanted) continue;
        var name = elementText(cells[grid.at.name]);
        if (name) contacts.push({ type: CONTACT_TYPES[t], name: name });
      }
    }
    return { ok: true, contacts: contacts };
  }

  /* The properties being acquired, street address and purchase price only. A
     property being refinanced contributes nothing. */
  function collectProperties(doc) {
    var grid = readGrid(doc, PROPERTIES_GRID, {
      address: "Address",
      transaction: "Transaction",
      price: "Purchase Price"
    });
    if (!grid.ok) return grid;
    var properties = [];
    for (var i = 0; i < grid.rows.length; i += 1) {
      var cells = grid.rows[i];
      if (!ACQUISITION.test(elementText(cells[grid.at.transaction]))) continue;
      var address = streetAddress(cells[grid.at.address]);
      if (!address) continue;
      // A $0 purchase price is one nobody has filled in yet, not a free house.
      var price = optionalValue(elementText(cells[grid.at.price]));
      properties.push(price ? { address: address, purchasePrice: price } : { address: address });
    }
    return { ok: true, properties: properties };
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
    var contacts = collectContacts(doc);
    if (!contacts.ok) missing.push(contacts.error);
    var properties = collectProperties(doc);
    if (!properties.ok) missing.push(properties.error);
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
        terms: terms.terms,
        contacts: contacts.contacts,
        properties: properties.properties
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

  /* Land the filer on Hot Task's create form, after the copy and never instead
     of it (#198).

     A new tab rather than a navigation: this page is the loan, and taking the
     filer off it to file a task about it would be a worse trade than the two
     clicks this saves. `window.open` is also the only one of the two a browser
     can refuse, and a refusal has to be reported — a control that silently did
     nothing would look identical to one that worked, which is the same reason
     `copyText` doesn't swallow a refused clipboard.

     Returns which of the three things happened, so the button's confirmation
     says the true one. */
  function openHotTask() {
    var url = hotTaskCreateFormLink();
    if (!url) return "off";
    var opened = null;
    try {
      opened = window.open(url, "_blank", "noopener");
    } catch (err) {
      opened = null;
    }
    return opened ? "opened" : "blocked";
  }

  var COPIED_MESSAGE = {
    opened: "Copied — opening Hot Task",
    /* The copy is the part that matters and it landed; only the shortcut
       didn't. */
    blocked: "Copied — couldn't open Hot Task. Go there and paste.",
    off: "Copied — paste it into Hot Task"
  };

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

    /* The contacts and properties arrive by background request after the page
       renders (#197), so the control has a waiting state. It watches rather
       than fetching on click for a practical reason as well as an honest one: a
       clipboard write has to happen inside the press that asked for it, and a
       press that first waited several seconds for a grid has lost that. */
    var loading = !gridsSettled(document);

    function idleLabel() {
      return loading ? LOADING_LABEL : IDLE_LABEL;
    }

    button.textContent = idleLabel();

    var resetTimer = 0;
    function say(message) {
      button.textContent = message;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(function () {
        button.textContent = idleLabel();
        resetTimer = 0;
      }, MESSAGE_MS);
    }

    /* Poll until both grids have painted, then let the button offer the copy.

       Polling rather than a MutationObserver because the grids are redrawn
       wholesale and the thing being waited for is "rows exist", which is one
       cheap read. The ceiling exists so a grid that never arrives leaves a
       pressable button: pressing it then reports what didn't load, which is
       #197's "reported, not silently omitted". */
    function watchForGrids() {
      if (!loading) return;
      var waitedMs = 0;
      setTimeout(function tick() {
        waitedMs += POLL_MS;
        if (gridsSettled(document) || waitedMs >= LOAD_CEILING_MS) {
          loading = false;
          // Don't stamp over a message the filer is mid-read of.
          if (button.textContent === LOADING_LABEL) button.textContent = IDLE_LABEL;
          return;
        }
        setTimeout(tick, POLL_MS);
      }, POLL_MS);
    }

    button.addEventListener("click", function () {
      if (loading) {
        say("Still loading this loan's contacts and properties — try again in a moment.");
        return;
      }
      var result = collect(document, location);
      if (!result.ok) {
        say(result.error);
        return;
      }
      var text = JSON.stringify(result.payload);
      copyText(text).then(
        function () {
          say(COPIED_MESSAGE[openHotTask()]);
        },
        function () {
          say("Couldn't reach the clipboard. Copy this page's URL by hand.");
        }
      );
    });

    document.body.appendChild(button);
    watchForGrids();
  }

  mount();
})();
