/* Find a loan from the Tasks list header and see only its tasks (#333).

   Three pieces, all small, all here so a node script can render them:

   - `loanSearchResults`, the whole suggestion rule. It is the create form's
     ranking, `loanTypeaheadSuggestions`, at the create form's limit, so a
     partial or misspelt name gives the same list in the same order in both
     places, and an empty box offers the viewer's own loans. The one thing that
     ranking cannot do is find a pasted Humperdink link, because it only reads
     names; the link is a loan's canonical key, so a pasted one is looked up by
     shared `findLoanForCreate`, whose link half is `normalizeLinkKey` equality, and
     not scored at all. A link no loan carries
     is a no-match rather than a fuzzy guess at a URL.
   - `LoanSearch`, the trigger and its box. It narrows nothing itself: it hands
     the picked loan up, and `visibleBoardTasks` does the narrowing, so the
     heading, count, sections, empty state and Collapse all keep reading one
     list.
   - `LoanSearchStatus` and `LoanSearchEmpty`, the way back while narrowed.

   The suggestion list is `LoanSuggestionList`, lifted out of the create form so
   both draw the same options. The box around it is not shared, for the reasons
   that file gives.

   Not persisted, and nothing here reads storage: a reload is the full board. */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { findLoanForCreate, loanTypeaheadSuggestions, nextHighlightIndex } from "@loan-tasks/shared";
import type { Loan, LoanMatch } from "@loan-tasks/shared";

import { SearchIcon } from "./icons";
import { LoanSuggestionList } from "./loan-suggestion-list";

/* The create form's cut. `loan-search-sim-test.mjs` reads the form's call and
   fails if the two drift. */
export const LOAN_SEARCH_LIMIT = 6;

export type LoanSearchResults =
  | { kind: "suggestions"; matches: LoanMatch[] }
  | { kind: "no-match" }
  | { kind: "empty" };

export const loanSearchResults = (query: string, loans: Loan[], myLoanIds: Set<string>): LoanSearchResults => {
  const trimmed = query.trim();
  /* The link lookup is shared `findLoanForCreate`, the rule filing already uses
     to decide a pasted link names an existing loan, asked with no name so only
     its link half can answer. */
  const byLink = trimmed ? findLoanForCreate("", trimmed, loans) : undefined;
  if (byLink) return { kind: "suggestions", matches: [{ loan: byLink, score: 1 }] };
  if (/^https?:\/\//i.test(trimmed)) return { kind: "no-match" };
  const matches = loanTypeaheadSuggestions(query, loans, myLoanIds, LOAN_SEARCH_LIMIT);
  if (matches.length > 0) return { kind: "suggestions", matches };
  /* An empty box with no loans of the viewer's has nothing to offer, which is
     not the same as the viewer having asked for something that is not there. */
  return trimmed ? { kind: "no-match" } : { kind: "empty" };
};

export const LoanSearch = ({
  loans,
  myLoanIds,
  onPick,
  initialOpen = false,
  initialQuery = ""
}: {
  loans: Loan[];
  myLoanIds: Set<string>;
  onPick: (loan: Loan) => void;
  /* Only for rendering an open box in a test; the app always starts closed. */
  initialOpen?: boolean;
  initialQuery?: string;
}) => {
  const [open, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState(initialQuery);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();

  const results = useMemo(() => loanSearchResults(query, loans, myLoanIds), [query, loans, myLoanIds]);
  const matches = results.kind === "suggestions" ? results.matches : [];

  /* Closing forgets the typing: the next open starts on the viewer's own loans,
     the way the create form's box does on focus. */
  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (loan: Loan): void => {
    onPick(loan);
    close(true);
  };

  /* An outside press closes it, like the app menu beside it. Escape is handled
     on the wrapper below instead, where it can be kept from reaching anything
     else that listens for it. */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /* Escape closes the box and nothing else: stopped here so an open card menu
     or the create form's own Escape handler never sees the same press. */
  const onWrapKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const trimmedQuery = query.trim();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (matches.length === 0) return;
      e.preventDefault();
      setHighlight(nextHighlightIndex(highlight, e.key === "ArrowDown" ? 1 : -1, matches.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      /* Nothing highlighted takes the top suggestion once something is typed,
         so a pasted link is one paste and one Return. An empty box is only a
         shortlist, and a stray Return on it narrows nothing. */
      const target = highlight >= 0 ? matches[highlight] : trimmedQuery ? matches[0] : undefined;
      if (target) pick(target.loan);
    }
  };

  return (
    <div className="loan-search" ref={wrapRef} onKeyDown={onWrapKey}>
      <button
        ref={triggerRef}
        type="button"
        className="app-menu-trigger loan-search-trigger"
        aria-label="Search for a loan"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <SearchIcon />
      </button>
      {open && (
        <div className="loan-search-panel" role="search">
          <input
            className="loan-search-input"
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Loan name or Humperdink link"
            aria-label="Loan name or Humperdink link"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(-1);
            }}
            onKeyDown={onInputKey}
          />
          {matches.length > 0 && (
            <LoanSuggestionList
              id={listId}
              className="loan-search-list"
              matches={matches}
              highlight={highlight}
              optionId={(i) => `${listId}-${i}`}
              onHighlight={setHighlight}
              onPick={pick}
            />
          )}
          {results.kind === "no-match" && (
            <p className="loan-search-none" role="status">
              No loan matches that.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/* Beside the heading while narrowed. The heading itself carries the loan's
   name; this is the way back, and its accessible name says which search it
   ends. */
export const LoanSearchStatus = ({ loan, onClear }: { loan: Loan; onClear: () => void }) => (
  <button
    type="button"
    className="board-show-everyone"
    aria-label={`Clear search for ${loan.name}`}
    onClick={onClear}
  >
    Clear search
  </button>
);

/* A picked loan with nothing on the board. Said plainly, so an empty list reads
   as an answer rather than as a broken board. */
export const LoanSearchEmpty = ({ loan, onClear }: { loan: Loan; onClear: () => void }) => (
  <div className="empty-card">
    {`No tasks for ${loan.name} on the board. `}
    <button type="button" className="board-show-everyone" onClick={onClear}>
      Clear search
    </button>
  </div>
);
