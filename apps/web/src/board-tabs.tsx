import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { BoardTab } from "./board-filter";

export type { BoardTab } from "./board-filter";

/* The Tasks board's tab row (#363, three tabs since #390): All, Mine, then
   Drafts.

   All is the board under Everyone and Mine the board under Mine; they replaced
   the app menu's Show row, which kept a choice people make all day one tap too
   deep. Drafts are the viewer's Saved for Later tasks (ADR-0011), kept in a tab
   of their own so they sit in one place however the board is viewed, and never
   mixed in with tasks.

   While a loan is searched, All carries the loan's name, which can be long and
   is the one label that ellipsizes. Every tab is drawn, with its count,
   including zero.

   The names are the short ones at every width. `All Tasks`, `My Tasks` and
   `Task Drafts` were cut off on phones and narrow windows, and a second set of
   names swapped in under a breakpoint still left the widths just above it
   clipping. A screen reader still hears the full name: it sits in an
   `sr-only` span and the short one on screen is `aria-hidden`. A searched
   loan's name has no second form.

   Which tab is open is App's. All / My is stored (as the Show value it
   replaced), Task Drafts never is; `tabForShow` and `showForTab` in
   `board-filter.ts` are the mapping. The body under the row is chosen by
   `boardBody` there too.

   The ARIA tabs pattern: one tablist, the selected tab the only one in the Tab
   order, arrows and Home/End moving the selection with focus following it. */

export const BOARD_PANEL_ID = "board-panel";

export const boardTabId = (tab: BoardTab): string => `board-tab-${tab}`;

const ORDER: readonly BoardTab[] = ["all", "mine", "drafts"];

export const BoardTabs = ({
  tab,
  onTabChange,
  allLabel,
  allTitle,
  allCount,
  mineCount,
  draftsCount
}: {
  tab: BoardTab;
  onTabChange: (tab: BoardTab) => void;
  /* A searched loan's name stands in for `All` while the search is on. */
  allLabel?: ReactNode;
  /* The full text behind a label that may be cut short, a long loan name. */
  allTitle?: string;
  allCount: number;
  mineCount: number;
  draftsCount: number;
}) => {
  const refs = useRef<Partial<Record<BoardTab, HTMLButtonElement | null>>>({});
  const tabs: ReadonlyArray<{ value: BoardTab; label: ReactNode; spoken?: string; title?: string; count: number }> = [
    allLabel === undefined
      ? { value: "all", label: "All", spoken: "All Tasks", count: allCount }
      : { value: "all", label: allLabel, ...(allTitle ? { title: allTitle } : {}), count: allCount },
    { value: "mine", label: "Mine", spoken: "My Tasks", count: mineCount },
    { value: "drafts", label: "Drafts", spoken: "Task Drafts", count: draftsCount }
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = ORDER.indexOf(tab);
    let next: BoardTab | undefined;
    if (e.key === "ArrowRight") next = ORDER[(at + 1) % ORDER.length];
    else if (e.key === "ArrowLeft") next = ORDER[(at - 1 + ORDER.length) % ORDER.length];
    else if (e.key === "Home") next = ORDER[0];
    else if (e.key === "End") next = ORDER[ORDER.length - 1];
    if (!next) return;
    e.preventDefault();
    onTabChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="board-tabs" role="tablist" aria-label="Board" onKeyDown={onKeyDown}>
      {tabs.map(({ value, label, spoken, title, count }) => {
        const selected = value === tab;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            id={boardTabId(value)}
            className={selected ? "tab-btn board-tab tab-active" : "tab-btn board-tab"}
            aria-selected={selected}
            {...(selected ? { "aria-controls": BOARD_PANEL_ID } : {})}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              refs.current[value] = el;
            }}
            onClick={() => onTabChange(value)}
          >
            <span className="board-tab-label" {...(title ? { title } : {})}>
              {spoken ? (
                <>
                  <span className="sr-only">{spoken}</span>
                  <span aria-hidden="true">{label}</span>
                </>
              ) : (
                label
              )}
            </span>
            <span className="section-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
};
