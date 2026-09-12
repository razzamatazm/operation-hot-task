import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { BoardTab } from "./board-filter";

export type { BoardTab } from "./board-filter";

/* The Tasks board's tab row (#363, three tabs since #390): All Tasks, My Tasks,
   then Task Drafts.

   All Tasks is the board under Everyone and My Tasks the board under Mine; they
   replaced the app menu's Show row, which kept a choice people make all day one
   tap too deep. Task Drafts are the viewer's Saved for Later tasks (ADR-0011),
   kept in a tab of their own so they sit in one place however the board is
   viewed, and never mixed in with tasks.

   While a loan is searched, All Tasks carries the loan's name, which can be long
   and is the one label that ellipsizes. Every tab is drawn, with its count,
   including zero.

   Under 480px the three names do not fit on the header's first line at 360px
   (measured with the touch floor on: `All Tasks` lost 12px to an ellipsis), so
   each tab also carries a short name, `All`, `Mine`, `Drafts`, which the phone
   rule in styles.css shows while the full name is visually hidden. Hidden, not
   removed, and the short one is `aria-hidden`: a screen reader hears `All Tasks
   13` at every width. A searched loan's name has no short form.

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
  /* A searched loan's name stands in for `All Tasks` while the search is on. */
  allLabel?: ReactNode;
  /* The full text behind a label that may be cut short, a long loan name. */
  allTitle?: string;
  allCount: number;
  mineCount: number;
  draftsCount: number;
}) => {
  const refs = useRef<Partial<Record<BoardTab, HTMLButtonElement | null>>>({});
  const tabs: ReadonlyArray<{ value: BoardTab; label: ReactNode; short?: string; title?: string; count: number }> = [
    allLabel === undefined
      ? { value: "all", label: "All Tasks", short: "All", count: allCount }
      : { value: "all", label: allLabel, ...(allTitle ? { title: allTitle } : {}), count: allCount },
    { value: "mine", label: "My Tasks", short: "Mine", count: mineCount },
    { value: "drafts", label: "Task Drafts", short: "Drafts", count: draftsCount }
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
      {tabs.map(({ value, label, short, title, count }) => {
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
              {short ? (
                <>
                  <span className="board-tab-name">{label}</span>
                  <span className="board-tab-short" aria-hidden="true">{short}</span>
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
