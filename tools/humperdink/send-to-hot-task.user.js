// ==UserScript==
// @name         Send to Hot Task
// @namespace    https://github.com/razzamatazm/operation-hot-task
// @version      1.10.1
// @description  Copy a Humperdink loan to the clipboard, then open Hot Task in Teams desktop on a new LOI Check.
// @author       Operation Hot Task
// @match        https://humperdink.loneoakfund.com/Loans/Details/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://loftools.thepopcorn.party/userscripts/send-to-hot-task.user.js
// @updateURL    https://loftools.thepopcorn.party/userscripts/send-to-hot-task.user.js
// ==/UserScript==

/* See README.md beside this file for install instructions. This file is the
   source of truth; loftools serves a copy of it, and Tampermonkey updates from
   that copy, so raise @version with every change or nobody receives it.

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
   adds a contact.

   Two more things since #442. Each conditional panel's on/off switch decides
   whether that panel travels at all, because Humperdink leaves a switched-off
   panel's figures sitting in its inputs. And each property's release price
   lives in its property details, not on this page, so the control fetches
   them while it waits for the grids, never during the press. */

(function () {
  "use strict";

  /* Contract — keep in sync with packages/shared/src/humperdink.ts. */
  var PAYLOAD_KIND = "hot-task-humperdink";
  var PAYLOAD_VERSION = 2;
  var TITLE_SUFFIX = " - details";
  var LOAN_DETAILS_PATH = /^\/Loans\/Details\/[^/]+\/?$/i;

  var BUTTON_ID = "hot-task-send-control";
  var IDLE_LABEL = "Export to HT";
  var LOADING_LABEL = "Loading…";
  var MESSAGE_MS = 6000;
  /* How often to check whether Humperdink's background grids have painted, and
     how long to keep checking before giving up and letting the press report it
     (#197). */
  var POLL_MS = 250;
  var LOAD_CEILING_MS = 20000;

  /* The control lives in the Loan Terms panel header, immediately after the LOI
     button, whose jqx classes it clones so it is indistinguishable from
     Humperdink's own controls. Anchoring to a page element does mean a
     Humperdink reshuffle could take it away, and a missing button is a silent
     failure, so the anchor is watched rather than assumed: if the header has
     not appeared within ANCHOR_CEILING_MS the old floating button is mounted
     instead, and if Humperdink repaints the header later the control is put
     back. */
  var ANCHOR_ID = "btnLOIFile";
  var INLINE_LABEL = "Export to HT";
  /* Font Awesome 4, the version Humperdink ships. Alternatives that read the
     same way: fa-sign-out, fa-external-link, fa-upload, fa-clipboard. */
  var ICON_CLASS = "fa-share-square-o";
  var TOAST_ID = "hot-task-send-message";
  var ANCHOR_CEILING_MS = 8000;

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

  var SELLER_TERM_IDS = { sellerFinancingAmount: "SellerFinancingAmount" };
  var DISBURSEMENT_TERM_IDS = {
    initialAdvance: "InitialDisbursed",
    drawMinimum: "DrawMinimumAmount",
    drawIncrement: "DrawIncrementAmount"
  };
  var INTEREST_RESERVE_TERM_IDS = {
    interestReserveAmount: "interestReserveAmount",
    interestReserveMonths: "interestReserveMonths",
    interestReserveNotes: "txtarea_InterestRateNotes"
  };
  var RECONVEYANCE_TERM_IDS = { partialReconveyance: "txtpartialReconveyance" };

  /* Each conditional panel's on/off switch (#442). Humperdink keeps a panel's
     inputs on the page, figures and all, whichever way its switch is set: on a
     live loan with Disbursement Options switched off, Draw Minimum and
     Increment still read `$10,000`. So the switch, not the figures, says
     whether the loan uses the panel. Humperdink marks a switch on by giving its
     `.toggle-on` child the `active` class. A switch that has gone is reported,
     like a core id. */
  var PANEL_SWITCH_IDS = {
    extensions: "toggleExtensions",
    juniorFinancing: "toggleJuniorFinancePermit",
    sellerFinancing: "toggleSellerFinancingPermit",
    disbursement: "toggleHoldBack",
    interestReserve: "toggleInterestReserve",
    partialReconveyance: "toggleReconveyance"
  };

  /* What a financing panel sends when its Permitted switch is on and nothing
     is filled in yet, so the note still tells the checker it's allowed. */
  var PERMITTED = "Permitted";

  /* Extension rows (#442), numbered from 1 like the rate table, with an Add
     button of their own. Unlike the rate table, a loan with no extensions has
     no row elements at all, so a missing row 1 is an ordinary loan. The notes
     box sits on every loan. */
  var EXTENSION_ROW_IDS = ["ExtensionMonthStart", "ExtensionMonthEnd", "ExtensionRate", "ExtensionPoints"];
  var EXTENSION_NOTES_ID = "extensionstextarea";
  var MAX_EXTENSIONS = 12;

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

     The core terms deliberately do NOT get this treatment here: a zero there is
     a real value and travels as one. Hot Task decides what to show — it leaves
     a zero Broker Fee out of the note, and keeps every other core zero. */
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

  /* Whether a panel's switch is on, or null when there is no switch to ask. */
  function switchOn(doc, id) {
    var el = doc.getElementById(id);
    var knob = el && el.querySelector ? el.querySelector(".toggle-on") : null;
    if (!knob) return null;
    return (" " + String(knob.className) + " ").indexOf(" active ") >= 0;
  }

  /* The rate input's `%` comes from Humperdink's number formatting, which a
     row can be read without, so the line adds one when it's missing. */
  function percent(value) {
    return value && value.slice(-1) !== "%" ? value + "%" : value;
  }

  function readExtensions(doc) {
    var extensions = [];
    for (var row = 1; row <= MAX_EXTENSIONS; row += 1) {
      var start = doc.getElementById(EXTENSION_ROW_IDS[0] + row);
      var end = doc.getElementById(EXTENSION_ROW_IDS[1] + row);
      var rate = doc.getElementById(EXTENSION_ROW_IDS[2] + row);
      var points = doc.getElementById(EXTENSION_ROW_IDS[3] + row);
      if (!start && !end && !rate && !points) break;
      var extension = {
        startMonth: fieldValue(start),
        endMonth: fieldValue(end),
        rate: percent(fieldValue(rate)),
        points: optionalFieldValue(points)
      };
      if (extension.startMonth || extension.endMonth || extension.rate || extension.points) {
        extensions.push(extension);
      }
    }
    return extensions;
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

    var on = {};
    for (var panel in PANEL_SWITCH_IDS) {
      if (!Object.prototype.hasOwnProperty.call(PANEL_SWITCH_IDS, panel)) continue;
      var state = switchOn(doc, PANEL_SWITCH_IDS[panel]);
      if (state === null) missingIds.push(PANEL_SWITCH_IDS[panel]);
      on[panel] = state === true;
    }

    var extensionNotes = doc.getElementById(EXTENSION_NOTES_ID);
    if (!extensionNotes) missingIds.push(EXTENSION_NOTES_ID);
    if (on.extensions) {
      var extensions = readExtensions(doc);
      if (extensions.length > 0) terms.extensions = extensions;
      var notes = fieldValue(extensionNotes);
      if (notes) terms.extensionNotes = notes;
    }

    if (on.juniorFinancing) {
      var junior = readGroup(doc, JUNIOR_TERM_IDS);
      if (hasAny(junior)) {
        assign(terms, junior);
        assign(terms, readGroup(doc, BLENDED_TERM_IDS));
      } else {
        terms.juniorFinancingPermitted = PERMITTED;
      }
    }
    if (on.sellerFinancing) {
      var seller = readGroup(doc, SELLER_TERM_IDS);
      if (hasAny(seller)) assign(terms, seller);
      else terms.sellerFinancingPermitted = PERMITTED;
    }
    if (on.disbursement) assign(terms, readGroup(doc, DISBURSEMENT_TERM_IDS));
    if (on.interestReserve) assign(terms, readGroup(doc, INTEREST_RESERVE_TERM_IDS));
    if (on.partialReconveyance) assign(terms, readGroup(doc, RECONVEYANCE_TERM_IDS));

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
     Matched whole, case-insensitively, against the Type cell's text.
     Humperdink's full list is Borrower, Broker, Referral Source, Lender, Title,
     Escrow, Other, Silent Borrower and Assistant; everything not named here
     stays in Humperdink.

     A loan can carry more than one of any of these, and every match travels:
     the loop below walks all rows once per type rather than stopping at the
     first hit, because a two-borrower loan is ordinary and a note that names
     one of them is worse than one that names neither.

     `Silent Borrower` travels under its own name rather than being folded into
     `Borrower`, so the note says which one somebody is. Hot Task's parser
     takes a contact's type as text and prints it as written, so a type added
     here needs no matching change there. `Lender` joined in #442: the junior
     lender is a contact of that type. */
  var CONTACT_TYPES = ["Broker", "Borrower", "Silent Borrower", "Lender"];

  function normalise(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  }

  function elementText(el) {
    return el ? normalise(el.textContent) : "";
  }

  /* Humperdink packs a property's whole address into one cell, `<br/>`-split
     into street / city-state-zip / county. #197 wants the street line only.
     The grid's row data holds the same markup, which is how a release price
     finds its way back to its row. */
  /* Markup's text: tags dropped, and the few entities an address carries
     (`&amp;` above all) turned back into characters. */
  function markupText(markup) {
    return String(markup == null ? "" : markup)
      .replace(/<[^>]*>/g, "")
      .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, function (whole, name) {
        var lower = name.toLowerCase();
        if (lower.charAt(0) !== "#") {
          return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[lower];
        }
        var code = lower.charAt(1) === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return isNaN(code) ? whole : String.fromCharCode(code);
      });
  }

  function streetFromMarkup(markup) {
    var head = String(markup == null ? "" : markup).split(/<br\s*\/?>/i)[0];
    return normalise(markupText(head)).replace(/,+$/, "");
  }

  /* The city: the address cell's second line, up to its first comma. */
  function cityFromMarkup(markup) {
    var lines = String(markup == null ? "" : markup).split(/<br\s*\/?>/i);
    return lines.length > 1 ? normalise(markupText(lines[1]).split(",")[0]) : "";
  }

  function streetAddress(cell) {
    if (!cell) return "";
    var markup = cell.innerHTML == null ? "" : String(cell.innerHTML);
    return markup ? streetFromMarkup(markup) : elementText(cell).replace(/,+$/, "");
  }

  /* The whole address as a matching key. The painted cell and the grid's row
     data carry the same address, one as rendered HTML and one as the string
     behind it, so line breaks, tags, entities, spacing and case are set aside. */
  function addressKey(markup) {
    return normalise(markupText(String(markup == null ? "" : markup).replace(/<br\s*\/?>/gi, " "))).toLowerCase();
  }

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
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

  /* The people an LOI check needs, matched on the contact type text, each with
     their company and email when the grid has them. */
  function collectContacts(doc) {
    var grid = readGrid(doc, CONTACTS_GRID, { type: "Type", name: "Name", company: "Company", email: "Email" });
    if (!grid.ok) return grid;
    var contacts = [];
    for (var t = 0; t < CONTACT_TYPES.length; t += 1) {
      var wanted = CONTACT_TYPES[t].toLowerCase();
      for (var i = 0; i < grid.rows.length; i += 1) {
        var cells = grid.rows[i];
        if (elementText(cells[grid.at.type]).toLowerCase() !== wanted) continue;
        var name = elementText(cells[grid.at.name]);
        if (!name) continue;
        var contact = { type: CONTACT_TYPES[t], name: name };
        var company = elementText(cells[grid.at.company]);
        if (company) contact.company = company;
        var email = elementText(cells[grid.at.email]);
        if (email) contact.email = email;
        contacts.push(contact);
      }
    }
    return { ok: true, contacts: contacts };
  }

  /* ── Release prices (#442) ────────────────────────────────

     A property's release price isn't on the loan page. It lives in the
     property's details, which Humperdink loads as a separate partial when
     somebody opens the property, keyed by two ids only the properties grid's
     row data carries (the painted cells don't). The partial's `txtReleasePrice`
     input holds the price as a bare number in its `value`: `2950000.00`, or
     empty.

     Fetched while the control waits for the grids, never on the press: a
     clipboard write and the Teams launch both have to happen inside the press
     that asked for them, and a press that first waited on the network has lost
     that. They are fetched again whenever the pointer reaches the control (see
     `refreshReleasePrices`), so an edit since the page loaded is normally in
     before the press. */
  var PROPERTY_DETAILS_PATH = "/Loans/NewPropertyPartial";
  var RELEASE_PRICE_ID = "txtReleasePrice";

  /* The properties grid's row data, read through the page's own jQuery the way
     Humperdink's OpenProperty reads it, or null when it can't be read. */
  function propertyGridData() {
    var jq = window.jQuery;
    if (typeof jq !== "function") return null;
    try {
      var rows = jq("#PropertiesGrid").jqxGrid("getrows");
      return rows && typeof rows.length === "number" ? rows : null;
    } catch (err) {
      return null;
    }
  }

  /* `2950000.00` as `$2,950,000.00`, the way the rest of the note shows money.
     Zero is no price, the same as blank. */
  function dollars(raw) {
    var text = String(raw == null ? "" : raw).replace(/[$,\s]/g, "");
    if (!text || isNaN(Number(text))) return normalise(raw);
    if (Number(text) === 0) return "";
    var parts = text.split(".");
    return "$" + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (parts.length > 1 ? "." + parts[1] : "");
  }

  function fetchReleasePrice(row) {
    var href =
      PROPERTY_DETAILS_PATH +
      "?isNewProperty=false&pkpropertyid=" +
      encodeURIComponent(row.FKPropertyID) +
      "&pkloanspropertydetails=" +
      encodeURIComponent(row.PKLoanPropertyDetailID);
    return fetch(href, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("Humperdink answered " + response.status);
        return response.text();
      })
      .then(function (html) {
        var input = new DOMParser().parseFromString(html, "text/html").getElementById(RELEASE_PRICE_ID);
        if (!input) throw new Error("its property details have no " + RELEASE_PRICE_ID + " field");
        return dollars(input.getAttribute("value"));
      });
  }

  /* Every property's release price, listed by whole address in the grid data's
     order, or the first thing that went wrong. Never rejects. */
  function loadReleasePrices() {
    var rows = propertyGridData();
    if (!rows) {
      return Promise.resolve({ state: "failed", error: "the release prices (the properties grid's data couldn't be read)" });
    }
    return Promise.all(
      Array.prototype.map.call(rows, function (row) {
        return fetchReleasePrice(row).then(null, function (err) {
          var street = streetFromMarkup(row.Address) || "a property";
          throw new Error("the release price for " + street + " (" + (err && err.message) + ")");
        });
      })
    ).then(
      function (prices) {
        var byAddress = {};
        for (var i = 0; i < rows.length; i += 1) {
          var key = addressKey(rows[i].Address);
          if (!own(byAddress, key)) byAddress[key] = [];
          byAddress[key].push(prices[i]);
        }
        return { state: "ready", byAddress: byAddress };
      },
      function (err) {
        return { state: "failed", error: err && err.message ? err.message : "the release prices" };
      }
    );
  }

  /* Every property on the loan: street address, transaction type, purchase
     price and release price. #197 carried acquisitions only; #442 carries them
     all, because the desk writes loans on refinances too. */
  function collectProperties(doc, releases) {
    var grid = readGrid(doc, PROPERTIES_GRID, {
      address: "Address",
      transaction: "Transaction",
      price: "Purchase Price"
    });
    if (!grid.ok) return grid;
    if (!releases || releases.state === "waiting") {
      return { ok: false, error: "the release prices (they hadn't finished loading)" };
    }
    if (releases.state === "failed") return { ok: false, error: releases.error };
    var taken = {};
    var properties = [];
    for (var i = 0; i < grid.rows.length; i += 1) {
      var cells = grid.rows[i];
      var address = streetAddress(cells[grid.at.address]);
      if (!address) continue;
      /* Matched on the whole address, so two properties on one street in
         different towns keep their own prices however the grid is sorted; two
         at the very same address take theirs in order. A property with no price
         here was painted after the last fetch finished. */
      var cell = cells[grid.at.address];
      var key = addressKey(cell && cell.innerHTML ? cell.innerHTML : elementText(cell));
      var loaded = own(releases.byAddress, key) ? releases.byAddress[key] : [];
      var nth = own(taken, key) ? taken[key] : 0;
      if (nth >= loaded.length) {
        return {
          ok: false,
          error: "the release price for " + address + " (it hadn't loaded yet; try again in a moment, or reload the page)"
        };
      }
      taken[key] = nth + 1;
      var property = { address: address };
      var city = cell && cell.innerHTML ? cityFromMarkup(cell.innerHTML) : "";
      if (city) property.city = city;
      var transaction = elementText(cells[grid.at.transaction]);
      if (transaction) property.transactionType = transaction;
      // A $0 purchase price is one nobody has filled in yet, not a free house.
      var price = optionalValue(elementText(cells[grid.at.price]));
      if (price) property.purchasePrice = price;
      if (loaded[nth]) property.releasePrice = loaded[nth];
      properties.push(property);
    }
    return { ok: true, properties: properties };
  }

  /* Build the payload, or say what's missing. Never returns a partial payload:
     a half-filled create form is worse than no import, because the filer has no
     way to tell which half is wrong. */
  function collect(doc, location, releases) {
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
    var properties = collectProperties(doc, releases);
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

  /* ── Opening Hot Task (#414) ────────────────────────────────

     The loan travels on the clipboard, and only there. Once the copy lands, the
     control opens Hot Task in Teams desktop on a new LOI Check, which fills
     itself from that clipboard where Teams can read it (#415), or waits in its
     paste box for ⌘V (#409). The link that does it carries no loan data at all:
     Teams writes every deep link it receives into its local log.

     So this script does need to know where Hot Task lives, which is one Teams
     app. There is exactly one Hot Task install, and HOT_TASK_APP_ID is the `id`
     in its manifest (teams-app/operation-hot-task-teams/manifest.json). A new
     install means a new id here. The sentinel and entity id are copies of
     HUMPERDINK_ARRIVAL_ID and HOT_TASK_ENTITY_ID in
     packages/shared/src/deep-link.ts, and the link is `humperdinkArrivalLink`
     there, written out by hand because a userscript can't import it.
     `scripts/humperdink-import-sim-test.mjs` goes red if any of the three drift.

     `msteams:`, never Teams' https web link: that form detours through
     Microsoft's "Join conversation" launcher page, and the team uses
     Teams desktop only. It's a navigation rather than a new tab, since Chrome
     hands the protocol to Teams and the loan page stays where it is.

     Every press gets its own link: the sentinel plus a press tag, the time in
     base 36 and then a count of presses on this page. Teams desktop ignores a
     link identical to the page it is already showing, so the same link twice
     left Hot Task on screen and opened nothing. The count is what keeps two
     presses whose copies land in the same millisecond apart; the time keeps
     presses from different page loads apart. The time is always 8 characters
     in base 36 until the year 2059, so the two parts can't run together into
     another press's tag. */
  var HOT_TASK_APP_ID = "bca6db0b-b2b7-423f-8c22-f4348f3a0340";
  var HOT_TASK_ENTITY_ID = "loan-tasks-home";
  var HUMPERDINK_ARRIVAL_ID = "new:humperdink";
  var pressCount = 0;

  function arrivalLink() {
    pressCount += 1;
    var subEntityId = HUMPERDINK_ARRIVAL_ID + ":" + Date.now().toString(36) + pressCount.toString(36);
    return (
      "msteams:/l/entity/" +
      HOT_TASK_APP_ID +
      "/" +
      HOT_TASK_ENTITY_ID +
      "?context=" +
      encodeURIComponent(JSON.stringify({ subEntityId: subEntityId }))
    );
  }

  var COPIED_MESSAGE = "Copied. Opening Hot Task in Teams…";

  /* ── The control ────────────────────────────────────────────

     Humperdink's panel-header buttons are divs carrying jqx classes rather than
     <button>s. The control is a copy of the LOI button itself, icon and name
     swapped, so it sits on the bar exactly where Humperdink's own buttons do and
     a Humperdink restyle carries over on its own. It used to be built by hand
     with tuned margins, which sat a pixel or two off the rest of the bar. If the
     LOI button is ever a shape the swap doesn't recognise (no Font Awesome icon,
     or no name), the hand-built control is the fallback. */
  function createInlineControl(anchor) {
    var el = copyOfButton(anchor) || buildInlineControl(anchor);
    el.id = BUTTON_ID;
    el.setAttribute("role", "button");
    el.style.cursor = "pointer";
    /* jqx paints hover through a class rather than through CSS, so drive it by
       hand or the control is the one dead-looking thing in the bar. */
    el.addEventListener("mouseenter", function () {
      el.classList.add("jqx-fill-state-hover", "jqx-fill-state-hover-Lending");
    });
    el.addEventListener("mouseleave", function () {
      el.classList.remove("jqx-fill-state-hover", "jqx-fill-state-hover-Lending");
    });
    return el;
  }

  function copyOfButton(anchor) {
    if (typeof anchor.cloneNode !== "function") return null;
    var el = anchor.cloneNode(true);
    var icon = el.querySelector(".fa");
    var name = firstWords(el);
    if (!icon || !name) return null;
    /* A copy keeps everything that makes the original the LOI button: its id,
       `name="LOI"`, the `lending-controls-button` marker Humperdink's own code
       finds its buttons by, and any inline handler. Kept, the page would have a
       second LOI button that opens the LOI. Only presentation survives. */
    /* Before the ids go: Humperdink styles the LOI button through `#btnLOIFile`
       as well as through its classes, and the id is the one thing a copy can
       never keep. Without those rules the control rides a little high and
       leaves a gap under it, so each box takes its vertical metrics from what
       its original actually renders with, whatever rule set them. */
    matchVerticalTree(el, anchor);
    var nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i += 1) stripIdentity(nodes[i]);
    /* The LOI button's inline width is sized to "LOI"; "Export to HT" spilled out
       of it. Let the control size to its own name. */
    el.style.removeProperty("width");
    /* Only the resting look travels. A copy taken while LOI was hovered, pressed
       or disabled would otherwise wear that state for good. */
    el.className = String(el.className)
      .split(/\s+/)
      .filter(function (name) {
        return name && !/-(hover|pressed|disabled)(-|$)/.test(name);
      })
      .join(" ");
    el.setAttribute("aria-disabled", "false");
    icon.className = swapIcon(icon.className);
    var label = document.createElement("span");
    label.className = "hot-task-label";
    label.style.whiteSpace = "nowrap";
    name.parentNode.replaceChild(label, name);
    return el;
  }

  /* What holds a header button on the bar's centre line. Vertical only, and
     that is the whole point of the list. 1.9.4 copied every box property and
     1.9.5 took it back out for good reasons: it rewrote LOI's
     `padding-left: 10px !important` as an ordinary declaration, and it could
     capture a header that hadn't painted. The horizontal side needs no help —
     LOI's inline width is dropped just below and its padding is inherited
     untouched — so nothing here reads or writes a left, a right or a width. */
  var RENDERED_VERTICAL = [
    "display", "box-sizing", "vertical-align",
    "height", "min-height", "line-height", "font-size",
    "margin-top", "margin-bottom", "padding-top", "padding-bottom"
  ];
  /* Offsets only travel with `position: relative`; copying an absolute one
     would stack the control on top of the LOI button. */
  var RELATIVE_OFFSETS = ["position", "top", "bottom"];

  /* The original's rendered style, or null when there is nothing worth reading.
     A header that hasn't painted yet measures zero, and a copy of that would be
     a flattened control that never recovers. */
  function renderedStyle(original) {
    if (typeof window.getComputedStyle !== "function") return null;
    var style = window.getComputedStyle(original);
    if (!style) return null;
    return parseFloat(style.getPropertyValue("height")) > 0 ? style : null;
  }

  function matchVertical(copy, original) {
    if (!copy.style || typeof copy.style.setProperty !== "function") return;
    var style = renderedStyle(original);
    if (!style) return;
    var names = style.getPropertyValue("position") === "relative" ? RENDERED_VERTICAL.concat(RELATIVE_OFFSETS) : RENDERED_VERTICAL;
    for (var i = 0; i < names.length; i += 1) {
      var value = style.getPropertyValue(names[i]);
      if (!value) continue;
      /* Never downgrade an `!important` the copy already carries: setting a
         property plainly would drop its priority, which is how the earlier
         version broke LOI's padding. */
      if (typeof copy.style.getPropertyPriority === "function" && copy.style.getPropertyPriority(names[i]) === "important") continue;
      copy.style.setProperty(names[i], value);
    }
  }

  /* The button and every box inside it, each against the original it came from. */
  function matchVerticalTree(copy, original) {
    matchVertical(copy, original);
    var originals = typeof original.querySelectorAll === "function" ? original.querySelectorAll("*") : [];
    var copies = typeof copy.querySelectorAll === "function" ? copy.querySelectorAll("*") : [];
    for (var i = 0; i < copies.length && i < originals.length; i += 1) matchVertical(copies[i], originals[i]);
  }

  var PRESENTATION_ATTRIBUTE = /^(class|style|role|title|aria-.*)$/i;

  function stripIdentity(node) {
    if (typeof node.removeAttribute !== "function") return;
    var identity = [];
    for (var i = 0; i < (node.attributes ? node.attributes.length : 0); i += 1) {
      if (!PRESENTATION_ATTRIBUTE.test(node.attributes[i].name)) identity.push(node.attributes[i].name);
    }
    for (var j = 0; j < identity.length; j += 1) node.removeAttribute(identity[j]);
  }

  /* The first text with something in it: the button's name. */
  function firstWords(node) {
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      if (child.nodeType === 3 && child.nodeValue.trim()) return child;
      if (child.nodeType === 1) {
        var found = firstWords(child);
        if (found) return found;
      }
    }
    return null;
  }

  /* Font Awesome's size and width modifiers stay; the glyph is swapped. */
  function swapIcon(className) {
    var kept = String(className)
      .split(/\s+/)
      .filter(function (name) {
        return name && (!/^fa-/.test(name) || /^fa-(lg|fw|[2-5]x)$/.test(name));
      });
    kept.push(ICON_CLASS);
    return kept.join(" ");
  }

  /* The fallback: the LOI button's classes on a hand-built body. */
  function buildInlineControl(anchor) {
    var el = document.createElement("div");
    el.className = anchor.className;
    el.style.cssText = "padding-left:10px !important;padding-right:12px;height:24px;margin-left:6px;cursor:pointer;";
    el.innerHTML =
      '<span class="fa ' + ICON_CLASS + ' fa-lg loanSettings" style="font-size:13px;margin-right:5px;margin-top:2px;"></span>' +
      '<div class="hot-task-label" style="margin-top:3px;white-space:nowrap;"></div>';
    return el;
  }

  /* The fallback, for when the panel header never turns up. */
  function createFloatingControl() {
    var el = document.createElement("button");
    el.id = BUTTON_ID;
    el.type = "button";
    el.style.cssText = [
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
    return el;
  }

  /* ── Messages ───────────────────────────────────────────────

     The floating button could grow to 320px and hold a whole sentence, and
     those sentences are this control's entire error reporting. A panel header
     button cannot, so rather than trimming them they move into a note pinned
     under the button: same text, same MESSAGE_MS, green edge on success and red
     on failure. */
  function showToast(anchor, message, ok) {
    var toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }
    var box = anchor.getBoundingClientRect();
    toast.textContent = message;
    toast.style.cssText = [
      "position:fixed",
      "top:" + Math.round(box.bottom + 8) + "px",
      "left:" + Math.round(Math.max(8, Math.min(box.left, window.innerWidth - 340))) + "px",
      "z-index:2147483647",
      "max-width:320px",
      "padding:9px 12px",
      "border:1px solid " + (ok ? "#1f8a3b" : "#b3261e"),
      "border-left-width:4px",
      "border-radius:4px",
      "background:#fff",
      "color:#1f1f1f",
      "font:600 12px/1.4 system-ui,sans-serif",
      "box-shadow:0 2px 10px rgba(0,0,0,0.2)"
    ].join(";");
    return toast;
  }

  function hideToast() {
    var toast = document.getElementById(TOAST_ID);
    if (toast) toast.remove();
  }

  function mount() {
    if (document.getElementById(BUTTON_ID)) return;

    var control = null;
    var inline = false;
    /* The contacts and properties arrive by background request after the page
       renders (#197), and the release prices are fetched once the properties
       are in (#442), so the control has a waiting state. It watches rather
       than fetching on click for a practical reason as well as an honest one: a
       clipboard write has to happen inside the press that asked for it, and a
       press that first waited several seconds for a grid has lost that. */
    var loading = true;
    var releases = { state: "waiting" };
    var releasesStarted = false;
    var refreshing = false;
    var resetTimer = 0;

    function setLabel(text) {
      if (!control) return;
      var label = control.querySelector(".hot-task-label");
      if (label) label.textContent = text;
      else control.textContent = text;
    }

    function idleLabel() {
      if (inline) return INLINE_LABEL;
      return loading ? LOADING_LABEL : IDLE_LABEL;
    }

    /* In the bar the label cannot be spent on `Loading…` without the button
       changing width mid-toolbar, so it dims and says why on hover instead. The
       floating fallback keeps the original wording. */
    function refreshIdle() {
      if (!control) return;
      setLabel(idleLabel());
      control.title = loading
        ? "Still loading this loan's contacts, properties and release prices"
        : "Copy this loan and open a new LOI Check in Hot Task";
      if (inline) control.style.opacity = loading ? "0.65" : "";
    }

    function say(message, ok) {
      if (resetTimer) clearTimeout(resetTimer);
      if (inline) {
        showToast(control, message, !!ok);
        resetTimer = setTimeout(function () {
          hideToast();
          resetTimer = 0;
        }, MESSAGE_MS);
        return;
      }
      setLabel(message);
      resetTimer = setTimeout(function () {
        refreshIdle();
        resetTimer = 0;
      }, MESSAGE_MS);
    }

    function onPress() {
      if (loading) {
        say("Still loading this loan's contacts, properties and release prices — try again in a moment.", false);
        return;
      }
      var result = collect(document, location, releases);
      if (!result.ok) {
        say(result.error, false);
        return;
      }
      var text = JSON.stringify(result.payload);
      /* Open Hot Task only once the copy has landed, so the LOI Check never
         opens onto a clipboard without the loan on it. Chrome launches an
         external protocol only on a user gesture, and a clipboard write resolves
         well inside the press's activation window, so this still counts as the
         press. The first time, Chrome asks whether to open Teams; ticking Always
         allow makes every later press go straight there. */
      copyText(text).then(
        function () {
          say(COPIED_MESSAGE, true);
          window.location.assign(arrivalLink());
        },
        function () {
          say("Couldn't reach the clipboard. Copy this page's URL by hand.", false);
        }
      );
    }

    /* Put the control in the Loan Terms header, or report that it isn't there
       yet. Never assumed: see the ANCHOR_ID note at the top. */
    function place() {
      if (document.getElementById(BUTTON_ID)) return true;
      var anchor = document.getElementById(ANCHOR_ID);
      if (!anchor || !anchor.closest(".loanpanelheader")) return false;
      control = createInlineControl(anchor);
      control.addEventListener("mouseenter", refreshReleasePrices);
      control.addEventListener("focus", refreshReleasePrices);
      control.addEventListener("click", function (event) {
        event.preventDefault();
        /* The control wears LOI's classes, so a Humperdink handler listening
           higher up for presses on its header buttons would otherwise take
           this for one of them. */
        event.stopPropagation();
        onPress();
      });
      anchor.insertAdjacentElement("afterend", control);
      inline = true;
      refreshIdle();
      return true;
    }

    function placeFloating() {
      if (document.getElementById(BUTTON_ID)) return;
      control = createFloatingControl();
      control.addEventListener("mouseenter", refreshReleasePrices);
      control.addEventListener("focus", refreshReleasePrices);
      control.addEventListener("click", onPress);
      document.body.appendChild(control);
      inline = false;
      refreshIdle();
    }

    function finishLoading() {
      if (!loading) return;
      loading = false;
      // Don't stamp over a message the filer is mid-read of.
      if (!resetTimer) refreshIdle();
    }

    /* Once, as soon as the properties grid has rows: the release prices hang
       off those rows, and not off the contacts. */
    function startReleasePrices() {
      if (releasesStarted) return;
      releasesStarted = true;
      loadReleasePrices().then(function (state) {
        releases = state;
        if (gridsSettled(document)) finishLoading();
      });
    }

    /* The pointer reaching the control fetches the release prices again in the
       background, so a price edited in Humperdink's property window since the
       page loaded, or a property added, is normally in before the press lands.
       The press itself never waits: it copies what the last finished fetch
       found, and refuses a property that fetch didn't include. */
    function refreshReleasePrices() {
      if (!releasesStarted || refreshing || releases.state === "waiting") return;
      refreshing = true;
      loadReleasePrices().then(function (state) {
        releases = state;
        refreshing = false;
      });
    }

    function loadSettled() {
      var properties = gridRows(document, PROPERTIES_GRID);
      if (properties && properties.length > 0) startReleasePrices();
      return gridsSettled(document) && releases.state !== "waiting";
    }

    /* Poll until both grids have painted and the release prices are in, then
       let the button offer the copy.

       Polling rather than a MutationObserver because the grids are redrawn
       wholesale and the thing being waited for is "rows exist", which is one
       cheap read. The ceiling exists so a grid or a fetch that never arrives
       leaves a pressable button: pressing it then reports what didn't load,
       which is #197's "reported, not silently omitted". */
    function watchForLoad() {
      if (loadSettled()) {
        finishLoading();
        return;
      }
      var waitedMs = 0;
      setTimeout(function tick() {
        waitedMs += POLL_MS;
        var settled = loadSettled();
        if (settled || waitedMs >= LOAD_CEILING_MS) finishLoading();
        /* Past the ceiling the control is pressable, but a properties grid that
           lands late still needs its release prices fetched, so keep watching
           for it until that has started. */
        if (settled || (!loading && releasesStarted)) return;
        setTimeout(tick, POLL_MS);
      }, POLL_MS);
    }

    /* The header is painted with the rest of the page, so this usually lands
       first time. When it doesn't, keep looking, and take the corner rather
       than nothing if it never shows. */
    if (!place()) {
      var waitedForAnchor = 0;
      var watcher = setInterval(function () {
        waitedForAnchor += POLL_MS;
        if (place()) {
          clearInterval(watcher);
          return;
        }
        if (waitedForAnchor >= ANCHOR_CEILING_MS) {
          clearInterval(watcher);
          placeFloating();
        }
      }, POLL_MS);
    }

    /* Humperdink repaints the panel header on collapse and on loan reload, and
       takes the control with it. Put it back. */
    new MutationObserver(function () {
      if (inline && !document.getElementById(BUTTON_ID)) place();
    }).observe(document.documentElement, { childList: true, subtree: true });

    watchForLoad();
  }

  mount();
})();
