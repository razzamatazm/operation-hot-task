import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

/* The Tasks board's tab row (#363): Tasks, then Task Drafts.

   Task Drafts are the viewer's Saved for Later tasks (ADR-0011). They used to be
   a section inside the list, placed differently in Grouped and Flat view and
   caught between the list's filters. A tab keeps them in one place however the
   board is viewed, and never mixed in with tasks.

   The row stands where the board's heading stood, so the Tasks tab carries what
   the heading said (`Tasks`, `My tasks`, or a searched loan's name) and its
   count. Task Drafts is always drawn, with its count, including zero.

   Which tab is open is App's, held in plain state and never stored: a reload
   opens on Tasks. The body under the row is chosen by `boardBody` in
   `board-filter.ts`.

   The ARIA tabs pattern: one tablist, the selected tab the only one in the Tab
   order, arrows and Home/End moving the selection with focus following it. */

export type BoardTab = "tasks" | "drafts";

export const BOARD_PANEL_ID = "board-panel";

export const boardTabId = (tab: BoardTab): string => `board-tab-${tab}`;

const ORDER: readonly BoardTab[] = ["tasks", "drafts"];

export const BoardTabs = ({
  tab,
  onTabChange,
  tasksLabel,
  tasksTitle,
  tasksCount,
  draftsCount
}: {
  tab: BoardTab;
  onTabChange: (tab: BoardTab) => void;
  tasksLabel: ReactNode;
  /* The full text behind a label that may be cut short, a long loan name. */
  tasksTitle?: string;
  tasksCount: number;
  draftsCount: number;
}) => {
  const refs = useRef<Partial<Record<BoardTab, HTMLButtonElement | null>>>({});
  const tabs: ReadonlyArray<{ value: BoardTab; label: ReactNode; title?: string; count: number }> = [
    { value: "tasks", label: tasksLabel, ...(tasksTitle ? { title: tasksTitle } : {}), count: tasksCount },
    { value: "drafts", label: "Task Drafts", count: draftsCount }
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
      {tabs.map(({ value, label, title, count }) => {
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
            <span className="board-tab-label" {...(title ? { title } : {})}>{label}</span>
            <span className="section-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
};
