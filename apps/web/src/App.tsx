import { app as teamsApp, authentication } from "@microsoft/teams-js";
import { ACTION_LABELS, CLOSED_STATUSES, ChecklistItem, CreateTaskInput, FraudCardAction, Loan, LoanTask, TaskHistoryEvent, TaskStatus, TaskType, TASK_TYPES, TASK_TYPE_LABELS, URGENCY_TIMEFRAMES, UrgencyLevel, UserIdentity, UserRole, byAttentionClaim, canAddNoteToTask, canApproveMerge, currentAssigneeSince, completedBy, archivedBy, canAssignTaskTo, canClaimTask, canCompleteTask, canMarkMergeDone, eligibleAssignees, canDeleteChecklistItem, canEditChecklist, canEditChecklistItemText, checklistSeat, ownChecklistNote, canRestoreTask, canReturnToPool, canTransitionStatus, canUnclaimTask, canUseCheckedPanel, canUseFixedPanel, NEEDS_FIXES_NOTE_REQUIRED, deriveMyLoanIds, formatWallDate, fraudCardActions, handedOffAt, hasUnreadNoteForViewer, isConfirmingLook, isOverdue, inPoolSince, isUnclaimed, isUnclaimedTooLong, isTaskParty, loanEditRefusal, standingInstructionsFor, unreadNoteFor, loanTypeaheadSuggestions, nextFlowStatuses, nextHighlightIndex, pendingPartyFor, readClaimIntent, restoreTargetStatus, sortChecklist, teamsTaskDeepLink, parseHumperdinkPayload, humperdinkNoteText, readCreateFormIntent, URGENCY_LEVELS, canAmendTask, sharedLinkOf, Autosave, SavedForLaterForm, SavedForLaterTask } from "@loan-tasks/shared";
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, SelectHTMLAttributes } from "react";
import { placePanel, maxPanelHeight, pinnedScrollTop } from "./panel-placement";
import { ratingBlock } from "./poop-rating";
import { createPortal } from "react-dom";
import { createTokenCache, sendWithToken } from "./auth-token";
import { SwitchableUser, chooseDevUser, loadDevUsers } from "./dev-users";
import { TaskEdit } from "./create-form-state";
import { ExpandOverrides, collapseTasks, expandedTaskIds, isTaskExpanded } from "./expand-state";
import { CourtHolds, holdCourt, isCourtHeld, releaseCourt } from "./court-latch";
import { BOARD_HISTORY_CHOICES, BOARD_HISTORY_DEFAULT, BOARD_HISTORY_KEY, BOARD_SHOW_KEY, BoardHistory, BoardShow, boardBody, isOnMineBoard, isWithinHistory, parseBoardHistory, parseBoardShow, showForTab, tabForLink, tabForShow, visibleBoardTasks } from "./board-filter";
import { BOARD_PANEL_ID, BoardTab, BoardTabs, boardTabId } from "./board-tabs";
import { LoanSearch, LoanSearchEmpty, LoanSearchStatus } from "./loan-search";
import { bylineOf, formatAgo, formatDate, initialsOf } from "./format";
import { LoanLinkCollision, MergeConfirmDialog, MergeDeclined, linkCollisionIn } from "./loan-merge-confirm";
import { CheckIcon, TrashIcon } from "./icons";
import { NoLoanToCorrect, saveTaskEdit } from "./save-task-edit";
import { DirectoryUser, TaskForm } from "./task-form";
import { TaskDraftsPage, taskDraftsCount } from "./saved-for-later";
import { SavedForLaterRequest, discardUnsavedRequest, forgetAutosaveRequest, keepAutosaveRequest, keepUnsavedRequest, loadAutosaveRequest, removeSavedForLaterRequest, reopenSavedForLaterRequest, saveForLaterRequest } from "./saved-for-later-requests";
import { autosaveCopy, browserDraftStorage, clearDraft, newerAutosave, readDraftCopy } from "./create-form-draft";
import { CardMenuScopeProvider, InstructionsSection, THREAD_HEAD_LABEL, ThreadMessages } from "./thread";
import { Timeline } from "./timeline";
import { useToast } from "./toast";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const IS_DEV = import.meta.env.DEV;
/* Nobody yet, in either build. Prod fills it from the SSO token; dev fills it
   from the server's active-user directory (`fetchDevUsers`, #309) — the mock
   switcher used to carry a hardcoded cast here, which drifted from the seed
   data. Either way the empty id is the signal that no identity has resolved,
   and every fetch below holds until it has, so nothing is ever requested as
   this placeholder. */
const INITIAL_USER: UserIdentity = {
  id: "",
  displayName: IS_DEV ? "Loading people" : "Signing in",
  roles: ["LOAN_OFFICER"]
};

/* SSO bearer token. Module-level so the standalone apiRequest helper can read
   it without prop-drilling. The cache re-acquires expired tokens on its own —
   see auth-token.ts for why holding one is not enough (#175). */
const tokenCache = createTokenCache(() => authentication.getAuthToken());

/* A failed request, with the server's answer still attached. Everything that
   catches one reads `.message` and always has, which is why this is an `Error`
   and not a result type; the status and body ride along for the one caller that
   needs more than a sentence — a loan edit refused because the link belongs to
   another loan answers 409 and names that loan, and the confirm-then-merge flow
   (#265) has to read that name to ask about it. */
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

/* `apiRequest` as the signed-in person, in the shape the Saved for Later
   request helpers take (#344). */
const savedForLaterRequestFor = (user: UserIdentity): SavedForLaterRequest =>
  <T,>(path: string, init: { method: string; body?: string }) => apiRequest<T>(path, init, user);

/* What `PATCH /loans/:loanId` answers with. `merged` is present only when this
   save actually folded another loan in — the transient notice ADR-0001's
   2026-07-31 addendum asks for is the only thing that reads it. */
interface LoanPatchResult {
  loan: Loan;
  merged?: { intoLoanId: string; intoLoanName: string; mergedName: string };
}

const apiRequest = async <T,>(path: string, init: RequestInit, user: UserIdentity): Promise<T> => {
  const send = (token: string | null): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        /* Teams: SSO bearer. Dev browser (no token): identify via the mock
           user headers so local role-switching still works. */
        ...(token
          ? { authorization: `Bearer ${token}` }
          : {
              "x-user-id": user.id,
              "x-user-name": user.displayName,
              "x-user-roles": user.roles.join(",")
            }),
        ...(init.headers ?? {})
      }
    });

  const response = await sendWithToken(tokenCache, send);

  /* No content: a removal that worked (DELETE /saved-for-later/:id, #344). There
     is no body to read, and reading one would throw on a success. */
  if (response.status === 204) return undefined as T;

  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status, data);
  }

  return data as T;
};

const formatPtDateOnly = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles"
  });
};

/* For closed tasks the deadline is moot — show how long ago it landed.
   Falls back to "done" when no completedAt is recorded. */
const formatRelativeCompleted = (iso?: string): string => {
  if (!iso) return "done";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60000) return "done just now";
  const min = Math.round(diffMs / 60000);
  if (min < 60) return `done ${min}m ago`;
  const hr = Math.round(diffMs / 3600000);
  if (hr < 24) return `done ${hr}h ago`;
  const day = Math.round(diffMs / 86400000);
  return `done ${day}d ago`;
};

/* The theme the *host* asked for. Teams tells the tab which of its three
   themes it is running, and until now that was the whole story. */
type HostTheme = "light" | "dark" | "contrast";
const normalizeTheme = (theme?: string): HostTheme =>
  theme === "dark" || theme === "contrast" ? theme : "light";

/* What the person chose in the app menu. "auto" is the default and means the
   old behaviour exactly: follow Teams, including live when Teams switches
   under us. Anything else pins the app and stops it following — which is the
   point of the control, and the reason it is not the default: a Teams tab that
   disagrees with Teams should be something you asked for. */
type ThemeChoice = "auto" | HostTheme;
const THEME_KEY = "loan-tasks:theme";
const THEME_CHOICES: ThemeChoice[] = ["auto", "light", "dark", "contrast"];
/* `short` is what the menu's one-line track has room for; `full` stays the
   accessible name, so a screen reader still hears `Match Teams`. */
const THEME_LABELS: Record<ThemeChoice, { short: string; full: string }> = {
  auto: { short: "Teams", full: "Match Teams" },
  light: { short: "Light", full: "Light" },
  dark: { short: "Dark", full: "Dark" },
  contrast: { short: "Contrast", full: "High contrast" }
};
const readThemeChoice = (): ThemeChoice => {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : "auto";
  } catch {
    return "auto";
  }
};

const applyTheme = (theme: HostTheme): void => {
  document.documentElement.setAttribute("data-theme", theme);
};

/* ── Grouped ("courts") view helpers ──────────────────────── */
/* Stable per-person color for the pair avatar chips: hashes the user id
   into one of 8 themed slots (--avatar-1..8 in styles.css) so the same
   person always gets the same chip color across rows and sessions. */
const AVATAR_PALETTE_SIZE = 8;
const avatarStyle = (id: string): CSSProperties => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const slot = (hash % AVATAR_PALETTE_SIZE) + 1;
  return { background: `var(--avatar-${slot})`, color: "var(--avatar-ink)", border: "none" };
};

/* Whose court is the ball in? Drives the grouped buckets. Mirrors the
   collapsed-row primary-action ladder so the section a task lands in and the
   button it offers agree. Permission edge cases (e.g. a LOAN_DOCS assignee
   at CLAIMED whose next move is Merge Done, not Complete) are still gated by
   the action ladder itself — a "you" card may carry no quick button and be
   acted on from the expanded body. */
type Court = "you" | "pool" | "them" | "done";
const courtOf = (task: LoanTask, user: UserIdentity): Court => {
  if (CLOSED_STATUSES.includes(task.status)) return "done";
  if (task.status === "OPEN") {
    // An OPEN task you created isn't "up for grabs" for you — you're waiting on
    // someone else to claim it, so it belongs in your "In flight" court.
    return task.createdBy.id === user.id ? "them" : "pool";
  }
  const isAssignee = task.assignee?.id === user.id;
  const isCreator = task.createdBy.id === user.id;
  // FRAUD two-phase (#39): the ball alternates between the requester (creator)
  // and the fraud checker (assignee). CLAIMED (checker's initial pass) falls
  // through to the generic assignee-owns-CLAIMED rule below. AWAITING_ITEMS is
  // the requester's move (gather the outstanding items back). PENDING_APPROVAL
  // is the checker's move (approve or send back) — unless it's been released
  // (no assignee), when it's up for grabs by any fraud checker.
  if (task.taskType === "FRAUD") {
    if (task.status === "AWAITING_ITEMS") return isCreator ? "you" : "them";
    if (task.status === "PENDING_APPROVAL") {
      if (!task.assignee) return isCreator ? "them" : "pool";
      return isAssignee ? "you" : "them";
    }
  }
  if (task.status === "CLAIMED" && isAssignee) return "you";
  // The merge rungs read the shared seat predicates rather than restating
  // creator/assignee here (#173), so the court a task lands in, the button the
  // ladder offers and the server's answer can't drift apart.
  if (task.status === "MERGE_DONE" && canApproveMerge(task, user)) return "you";
  if (task.status === "MERGE_APPROVED" && canCompleteTask(task, user)) return "you";
  // The corrections state is the creator's court (ADR-0007): the checker has
  // handed the ball back, and only the creator can move it on. An admin who
  // isn't a party to the task doesn't get every in-review task dumped on them.
  if (task.status === "NEEDS_REVIEW" && isCreator) return "you";
  return "them";
};

/* Calm, real coarse distance for a not-imminent deadline — hour/day grain,
   no ticking minutes, capped at ">1w" so a quiet task reads as a real distance
   instead of shouting a precise number (and never as an urgency category). */
const coarseDue = (dueIso: string, nowMs: number): string => {
  const h = (new Date(dueIso).getTime() - nowMs) / 3600000;
  if (h >= 24 * 7) return ">1w";
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return `${Math.round(h)}h`;
};

/* Live "2h 14m" / "38m" / "2d" countdown, sign flips on overdue. */
const liveCountdown = (dueIso: string, nowMs: number): { overdue: boolean; text: string } => {
  const diff = new Date(dueIso).getTime() - nowMs;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let text: string;
  if (d >= 2) text = `${d}d`;
  else if (h >= 1) text = `${h}h ${String(m % 60).padStart(2, "0")}m`;
  else text = `${m}m`;
  return { overdue: diff < 0, text };
};

/* Same shape as liveCountdown, read forwards: how long since `sinceIso`.
   liveCountdown is a count *down* whose `.overdue` flag is meaningless when the
   timestamp is already in the past, so this wraps it rather than letting call
   sites pass a past date to a function documented to count toward a deadline. */
const elapsedSince = (sinceIso: string, nowMs: number): string => liveCountdown(sinceIso, nowMs).text;

/* The task's one "other" timestamp — the line that sits under Created — and
   the label that names it. Two surfaces read this and they used to each decide
   for themselves: the collapsed row's due-cell tooltip and the expanded body's
   meta strip (the strip now lives in the row's hamburger, #166). They had
   already drifted — the tooltip knew a completed task shows when it completed
   and quotes no deadline, the strip still said "Due" over a date that had
   stopped meaning anything. One definition, so they can't drift again.

   `inTooltip` carries the one difference that is deliberate rather than drift:
   an OOO task reads "Returns" in the timestamp block, but its collapsed row
   already devotes a whole cell to the return date, so the tooltip stays quiet
   rather than repeating it under the cursor.

   `iso` is the same instant as `value`, unformatted, so the timestamp block can
   hand it to `<time dateTime>` — `value` is a localised string no machine reads.
   For an OOO task with no `returnDate` the two describe the same fallback from
   different angles: `value` is the due date rendered as a PT calendar day,
   `iso` the underlying instant. */
const taskTimeMeta = (task: LoanTask): { label: string; value: string; iso: string; inTooltip: boolean } | undefined => {
  if (task.status === "COMPLETED" || task.status === "ARCHIVED") {
    // No completion stamp means no second line at all. Falling back to the due
    // date here would quote a deadline at a task that has already landed.
    return task.completedAt
      ? { label: "Completed", value: formatDate(task.completedAt), iso: task.completedAt, inTooltip: true }
      : undefined;
  }
  if (task.taskType === "OOO") {
    return {
      label: "Returns",
      value: task.returnDate ? formatWallDate(task.returnDate) : formatPtDateOnly(task.dueAt),
      iso: task.returnDate ?? task.dueAt,
      inTooltip: false
    };
  }
  // The deadline is the requester's while a check sits with them, so neither
  // surface quotes one — the hand-off stamp is the honest thing to show.
  if (task.status === "AWAITING_ITEMS") {
    const handedOff = handedOffAt(task);
    return { label: "Sent to requester", value: formatDate(handedOff), iso: handedOff, inTooltip: true };
  }
  /* An unclaimed task has no deadline to quote — it restarts from whenever
     somebody takes it (ADR-0005), so the date sitting here would be wrong the
     moment it stopped being unclaimed. `groupedDue` already suppresses it in the
     row; this is the same task read through the tooltip and the hamburger, and
     the whole point of one definition is that they cannot disagree. */
  if (isUnclaimed(task)) {
    return undefined;
  }
  return { label: "Due", value: formatDate(task.dueAt), iso: task.dueAt, inTooltip: true };
};

/* The label-over-value "DUE IN / 6h" cell shown in a grouped row. Closed
   tasks read "✓ Nm ago"; OOO reads its return date. Within 4h (or overdue) we
   show the live ticking value; further out we fall back to a calm coarse
   distance so quiet tasks don't shout a precise number. */
const groupedDue = (
  task: LoanTask,
  nowMs: number,
  viewerIsRequester: boolean
): { label: string; value: string; overdue: boolean; done: boolean } => {
  if (task.status === "COMPLETED" || task.status === "ARCHIVED") {
    const stamp = task.completedAt ?? task.archivedAt;
    return { label: "", value: `✓ ${formatRelativeCompleted(stamp).replace(/^done\s*/, "")}`.trim(), overdue: false, done: true };
  }
  // Cancelled tasks are closed — the deadline is moot, so show when they were
  // cancelled (mirrors the completed/archived stamp, with a ✕ instead of ✓)
  // rather than a stale due countdown now that Cancelled rides the Done view.
  if (task.status === "CANCELLED") {
    const stamp = task.cancelledAt ?? task.updatedAt;
    return { label: "", value: `✕ ${formatRelativeCompleted(stamp).replace(/^done\s*/, "")}`.trim(), overdue: false, done: true };
  }
  if (task.taskType === "OOO") {
    return { label: "RETURNS", value: formatPtDateOnly(task.dueAt), overdue: false, done: false };
  }
  // FRAUD AWAITING_ITEMS is a wait on the requester, not a deadline the checker
  // is missing, so the row shows how long the requester has held it instead of
  // a deadline — same slot, same format, counting up, worded for whichever seat
  // is looking. This branch is a display choice; whether the task is *overdue*
  // is not decided here, see the shared call below.
  if (task.status === "AWAITING_ITEMS") {
    return {
      label: viewerIsRequester ? "WITH YOU" : "WITH REQUESTER",
      value: elapsedSince(handedOffAt(task), nowMs),
      overdue: false,
      done: false
    };
  }
  /* An unclaimed task's deadline is not yet anybody's obligation — it restarts
     from whenever someone takes it (ADR-0005) — so the row shows the ask rather
     than a clock. Nobody should be reading a red row about work they have not
     agreed to take, and the number they'd read would be wrong the moment they
     claimed it anyway.

     Its creator is the exception: they are the one person who can fix that by
     chasing a human, so they get a count-up instead. It runs from the moment the
     task entered the pool (#210), so a task handed back counts from the hand-back
     rather than from the day it was filed. */
  if (isUnclaimed(task)) {
    /* One count-up, calm or red, so the two cannot cover different sets of
       tasks (#213). They used to be two branches with a `status === "OPEN"`
       test on the calm one, which meant a Fraud Check released for any checker
       showed nothing at all and then snapped straight to red at twenty minutes.

       When it goes red is the shared rule's call, never this row's — same
       reason isOverdue is delegated below. The twenty-minute threshold, the
       empty-seat test and the OOO exemption all live in the shared model, so
       this row and the server cannot drift apart on what "too long unclaimed"
       means.

       Counted from when the task entered the pool, not from when it was filed
       (#210) — the shared accessor, so this row and the channel nag quote the
       same number. They are the same instant for a task nobody ever claimed. */
    if (viewerIsRequester) {
      return {
        label: "UNCLAIMED FOR",
        value: elapsedSince(inPoolSince(task), nowMs),
        overdue: isUnclaimedTooLong(task, new Date(nowMs)),
        done: false
      };
    }
    /* No label. `Within 24 Hours` is the widest thing this cell renders and it
       is self-describing; pairing it with an `URGENCY` label overruns the 154px
       due track, which has `white-space: nowrap` and would push the value back
       over the pair beside it. Closed rows drop the label for the same reason. */
    return { label: "", value: URGENCY_TIMEFRAMES[task.urgency], overdue: false, done: false };
  }
  const cd = liveCountdown(task.dueAt, nowMs);
  // Overdue is the shared rule's call, never this row's. It was the row
  // re-deriving `dueAt < now` locally that let a handed-off fraud check read
  // "OVERDUE BY 2h 45m" while the server, the reminder engine and every other
  // consumer already agreed it wasn't overdue. Delegating means the next status
  // added to the shared exclusion list reaches the badge and the red due stamp
  // without anyone remembering this file exists.
  if (isOverdue(task, new Date(nowMs))) return { label: "OVERDUE BY", value: cd.text, overdue: true, done: false };
  if (new Date(task.dueAt).getTime() - nowMs <= 4 * 3600000) {
    return { label: "DUE IN", value: cd.text, overdue: false, done: false };
  }
  return { label: "DUE IN", value: coarseDue(task.dueAt, nowMs), overdue: false, done: false };
};

const firstName = (displayName: string | undefined): string => {
  if (!displayName) return "";
  return displayName.split(/\s+/)[0] ?? displayName;
};

/* One active person from GET /api/users/directory — what both people-pickers
   (share, handoff) offer. `roles` came with the Handoff (ADR-0002): the handoff
   picker filters to people who can actually work the task, so a Fraud Check
   never offers someone the server would reject. */

/* LOAN_DOCS and FRAUD have multiple stages between claim and complete. The
   stage rides on the title beside the type so the type label stays terse.
   For FRAUD it also disambiguates a released final-approval task sitting in the
   pool ("Final Approval Needed") from a fresh unclaimed check.

   Bare words, no leading `- `. The hyphen is the join between two things that
   are sitting on one line, so it belongs to the row that draws them and not to
   the string: on a phone the stage drops to a line of its own under the type
   (2026-09-07), where a leading hyphen would read as a bullet. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType === "LOAN_DOCS") {
    if (task.status === "MERGE_DONE") return "Merge Done";
    if (task.status === "MERGE_APPROVED") return "Merge Approved";
    return "";
  }
  if (task.taskType === "FRAUD") {
    if (task.status === "AWAITING_ITEMS") return "Outstanding Items";
    if (task.status === "PENDING_APPROVAL") return task.assignee ? "Final Approval" : "Final Approval Needed";
    return "";
  }
  return "";
};

/* Sliders rather than a cog: what is behind it is a set of view preferences,
   not system configuration, and the app already has an Admin tab that is the
   cog-shaped thing. Same stroke weight and cap style as every other icon here.
   Sized via `.icon-settings` in styles.css; color follows `currentColor`. */
const SettingsIcon = () => (
  <svg
    className="icon-settings"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <line x1="4" y1="8" x2="20" y2="8" />
    <line x1="4" y1="16" x2="20" y2="16" />
    <circle cx="10" cy="8" r="2.5" />
    <circle cx="15" cy="16" r="2.5" />
  </svg>
);

/* Standard three-connected-nodes "share" glyph (#58). Hand-rolled inline SVG —
   the app ships no icon library (only the logo SVG + Unicode marks), so this is
   the one reusable share icon every share affordance should use. Sized via
   `.icon-share` in styles.css; color follows `currentColor`. */
const ShareIcon = () => (
  <svg
    className="icon-share"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.6" y1="10.7" x2="15.4" y2="6.3" />
    <line x1="8.6" y1="13.3" x2="15.4" y2="17.7" />
  </svg>
);

/* Portaled-panel geometry (#113, #122). The arithmetic — prefer downward, flip
   up when below can't hold it, clamp both axes into the viewport — lives in
   `panel-placement.ts` so a node test can drive it without a browser (#231).
   The widths here mirror the panels' own CSS and are only fallbacks for the
   first frame, before the panel has been measured. */
const SHARE_PANEL_WIDTH = 260;
const MENU_PANEL_WIDTH = 180;

/* Everything a panel needs to live outside the card that owns it (#113, #122):
   the trigger/panel ref pair (they're no longer ancestor/descendant once
   portaled), the fixed placement and its re-placement on scroll and resize, and
   outside-click dismissal. Returns the inline style the portaled panel spreads
   onto itself.

   Escape deliberately stays with the caller — the share popover has to swallow
   it (`stopPropagation`) so Escape inside the picker doesn't also close the
   create-task form it can be embedded in, while the actions menu wants a
   document-level listener because focus is usually still on the row. */
const useAnchoredPanel = <T extends HTMLElement>({
  open,
  align,
  fallbackWidth,
  onDismiss,
  /* Bump this when the panel's contents change size while open, so an
     up-flipped panel re-anchors to its new height. */
  remeasureKey,
  /* A second panel this one hosts, itself portaled and so not a DOM descendant
     — clicks in it must not read as "outside". */
  keepOpenWithin
}: {
  open: boolean;
  align: "left" | "right";
  fallbackWidth: number;
  onDismiss: () => void;
  remeasureKey?: unknown;
  keepOpenWithin?: string;
}) => {
  const triggerRef = useRef<T | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  /* The tallest the panel may draw before it scrolls internally. The placement
     promises the box fits on screen; this is what makes the DOM keep that
     promise when the contents would otherwise be taller than the viewport. */
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  /* Held in a ref so a caller's inline `close` doesn't re-subscribe the
     document listener on every render. */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const panel = panelRef.current;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    /* `getBoundingClientRect().height` rather than `offsetHeight`: the latter
       rounds to whole pixels and reads 0 while the panel is mid-layout, and a
       height of 0 is what let a panel on one of the bottom rows decide it had
       room below and run off the screen (#231). */
    const measured = panel?.getBoundingClientRect().height ?? 0;
    setPos(placePanel(
      trigger.getBoundingClientRect(),
      panel?.offsetWidth || fallbackWidth,
      measured,
      align,
      viewport
    ));
    setMaxHeight(maxPanelHeight(viewport));
  }, [align, fallbackWidth]);

  /* Layout effect, not effect: the panel renders hidden for one commit while
     `pos` is still null, and this measures and places it before the browser
     paints, so there's no visible jump. Scroll is captured so scrolling
     containers re-anchor it too, rather than letting it detach and float. */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, remeasureKey, place]);

  /* Re-place whenever the panel's own box changes size, not only when a caller
     remembers to bump `remeasureKey`. A panel that grows after it was placed —
     a second stage revealed, a validation line appearing, a font landing late —
     grows DOWNWARD from a top that was chosen for the old height, which is how
     it ends up over the bottom edge. Watching the element closes that whole
     family rather than the one case someone thought to key. */
  useLayoutEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      if (keepOpenWithin && (target as HTMLElement).closest?.(keepOpenWithin)) return;
      dismissRef.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, keepOpenWithin]);

  return {
    triggerRef,
    panelRef,
    /* Hidden — but still laid out, so it can be measured — until `place` runs. */
    style: {
      top: pos?.top ?? 0,
      left: pos?.left ?? 0,
      visibility: pos ? undefined : "hidden",
      ...(maxHeight !== undefined ? { maxHeight } : {})
    } as CSSProperties
  };
};

/* ── Share popover ───────────────────────────────────────────
   A compact icon trigger (#58) that opens an anchored panel with the
   people-picker, optional note, and Copy link. Collapses the share UI behind a
   button so it stops dominating the card (#52). Self-contained so the
   create-task flow (#46) can reuse it. Dismisses on outside-click or Esc.
   On a successful share (recorded server-side regardless of DM delivery) it
   fires a "Shared" toast and auto-dismisses; Copy link keeps its "Copied ✓"
   flash, then auto-dismisses (#60).

   The panel is PORTALED to document.body and fixed-positioned from the
   trigger's bounding rect (#113). It used to be an absolutely-positioned
   descendant opening upward, which the host `.task-card`'s `overflow: hidden`
   clipped — on a collapsed row most of the panel sat above the card's top edge
   and was simply cut away. That overflow rule can't go — the rounded corners
   need it — so the panel leaves the clipping context instead. It now
   prefers to open DOWNWARD and only flips up when there's no room below. */
const SharePopover = ({
  candidates,
  onShare,
  link,
  webLink,
  asMenuItem
}: {
  /* People the picker offers — pre-filtered by the caller (excludes creator,
     assignee, and self per #41). */
  candidates: DirectoryUser[];
  /* Fire the share. Resolves with whether the DM actually reached them; rejects
     on request failure so the panel can show inline status. */
  onShare: (targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  /* Copy-link target — the Teams deep link when the app id is known, the raw
     web URL otherwise. null/undefined hides the Copy link button — e.g. when
     there's no task id yet. */
  link?: string | null;
  /* Dev-only second target: the raw `#task-<id>` web URL, for testing the
     browser path when `link` is the Teams deep link. The extra button renders
     only under IS_DEV, so it's tree-shaken from a prod build. */
  webLink?: string | null;
  /* Render the trigger as the word "Share" in a full-width menu row instead
     of the icon-only square button, for use inside the actions menu. */
  asMenuItem?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  /* Chosen person + optional note + in-flight flag + copy-link flash. Success
     and failure are both toasts now (#60), so no status text lives in the panel;
     `state` only drives the button label + disabled while a share is in flight. */
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  /* Which copy button just fired, so only that one flashes "Copied ✓". */
  const [copied, setCopied] = useState<"none" | "teams" | "web">("none");
  const selectId = useId();
  const { showToast } = useToast();

  /* Close and reset the transient flags so the next open starts clean. */
  const close = () => {
    setOpen(false);
    setCopied("none");
    setState("idle");
  };

  /* Left-aligned: the trigger is a menu row or an inline icon, and both have
     room to their right. Esc is handled on the panel itself, not here — see
     `useAnchoredPanel`. */
  const { triggerRef, panelRef, style: panelStyle } = useAnchoredPanel<HTMLButtonElement>({
    open,
    align: "left",
    fallbackWidth: SHARE_PANEL_WIDTH,
    onDismiss: close
  });

  const handleShare = async () => {
    if (!targetId) return;
    setState("sending");
    try {
      /* The share is recorded server-side regardless of DM delivery, so any
         resolution is a success — confirm with a toast and auto-dismiss (#60). */
      await onShare(targetId, note.trim() || undefined);
      setTargetId("");
      setNote("");
      showToast("Shared", { variant: "success" });
      close();
    } catch {
      /* Re-enable the button so they can retry; the failure surfaces as a toast. */
      setState("idle");
      showToast("Couldn't share — try again", { variant: "error" });
    }
  };

  /* Copy a link to this task. `link` is the Teams deep link whenever the app
     id is known — a raw web URL pasted into Teams opens a browser and hits the
     SSO wall, so the copy target is the thing that actually works inside
     Teams. The person-picker above is the real deliverable; this is the
     lightweight "share link". Keep the "Copied ✓" flash, then auto-dismiss the
     popover (#60). */
  const handleCopy = async (value: string, which: "teams" | "web") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(close, 1100);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="share-pop">
      <button
        type="button"
        ref={triggerRef}
        className={asMenuItem ? "btn-sm btn-ghost" : "btn-sm btn-ghost share-pop-trigger"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Share"
        title="Share"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {asMenuItem ? "Share" : <ShareIcon />}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="share-pop-panel"
          role="dialog"
          aria-label="Share this task"
          style={panelStyle}
          /* Esc closes the popover and stops there: this picker can be embedded
             in the create-task form, whose own Esc handler would otherwise throw
             away the whole draft. */
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
        >
          <label className="share-pop-label" htmlFor={selectId}>Share</label>
          <select
            id={selectId}
            value={targetId}
            onChange={(e) => { setTargetId(e.target.value); setState("idle"); }}
            autoFocus
          >
            <option value="">Choose a person…</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
          <input
            className="share-pop-note"
            type="text"
            value={note}
            placeholder="Add a note (optional)"
            maxLength={280}
            onChange={(e) => { setNote(e.target.value); if (state !== "sending") setState("idle"); }}
          />
          <div className="share-pop-actions">
            <button type="button" className="btn-sm" disabled={!targetId || state === "sending"} onClick={() => void handleShare()}>
              {state === "sending" ? "Sharing…" : "Share"}
            </button>
            {link && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => void handleCopy(link, "teams")}>
                {copied === "teams" ? "Copied ✓" : "Copy link"}
              </button>
            )}
            {/* Dev-only escape hatch: the plain browser URL, for testing the
                non-Teams path. IS_DEV is statically false in a prod build, so
                this button is tree-shaken out (same trick as DEV_USERS). */}
            {IS_DEV && webLink && webLink !== link && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => void handleCopy(webLink, "web")}>
                {copied === "web" ? "Copied ✓" : "Copy web link"}
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

/* ── Handoff popover (ADR-0002) ───────────────────────────────
   Hands the task to someone else: person picker + optional note + one button.
   A sibling of SharePopover rather than a mode of it — share DMs somebody about
   a task, this one moves the task into their court, and mixing the two into one
   control makes it too easy to fire the wrong one.

   It reuses SharePopover's panel wholesale: `.share-pop-panel` carries the CSS
   AND two outside-click/Escape exemptions the hamburger menu keys off that
   class selector (`keepOpenWithin`, and the menu's Esc handler). Dropping the
   class in favour of a fresh one would close the menu out from under this panel
   the moment you clicked into it.

   Unlike share, a handoff can be REJECTED by the server (ineligible recipient,
   task closed, lost race), so the failure lands inline next to the picker
   instead of only in a toast — the message names the fix. */
const AssignPopover = ({
  label,
  candidates,
  onAssign
}: {
  /* ACTION_LABELS.ASSIGN on an unclaimed task, ACTION_LABELS.REASSIGN once it
     has an assignee. Picked by the caller, never composed here. */
  label: string;
  /* Eligible recipients, pre-filtered by the caller (every active user who can
     work this task, minus whoever already holds it — self included). */
  candidates: DirectoryUser[];
  /* Fire the handoff. Rejects with the server's message on refusal. */
  onAssign: (targetUserId: string, note?: string) => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  /* Server refusal, shown in the panel. Cleared on any edit so a stale reason
     never sits under a changed selection. */
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const { showToast } = useToast();

  const close = () => {
    setOpen(false);
    setState("idle");
    setError(null);
  };

  /* Left-aligned like the share popover, and remeasured when the inline error
     appears — it changes the panel's height, which moves an up-flipped panel. */
  const { triggerRef, panelRef, style: panelStyle } = useAnchoredPanel<HTMLButtonElement>({
    open,
    align: "left",
    fallbackWidth: SHARE_PANEL_WIDTH,
    onDismiss: close,
    remeasureKey: error
  });

  const handleAssign = async () => {
    if (!targetId) return;
    setState("sending");
    setError(null);
    try {
      await onAssign(targetId, note.trim() || undefined);
      const name = candidates.find((c) => c.id === targetId)?.displayName;
      setTargetId("");
      setNote("");
      showToast(name ? `Handed to ${firstName(name)}` : "Handed off", { variant: "success" });
      close();
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : "Couldn't hand this off — try again");
    }
  };

  return (
    <div className="share-pop">
      <button
        type="button"
        ref={triggerRef}
        className="btn-sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="share-pop-panel"
          role="dialog"
          aria-label="Hand this task to someone"
          style={panelStyle}
          /* Same reason as the share popover: this panel can open inside the
             create-task form, whose Esc handler would bin the whole draft. */
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
        >
          <label className="share-pop-label" htmlFor={selectId}>{label}</label>
          <select
            id={selectId}
            value={targetId}
            onChange={(e) => { setTargetId(e.target.value); setError(null); }}
            autoFocus
          >
            <option value="">Choose a person…</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
          <input
            className="share-pop-note"
            type="text"
            value={note}
            placeholder="Add a note (optional)"
            maxLength={280}
            onChange={(e) => { setNote(e.target.value); setError(null); }}
          />
          {error && <div className="share-pop-error" role="alert">{error}</div>}
          <div className="share-pop-actions">
            <button type="button" className="btn-sm" disabled={!targetId || state === "sending"} onClick={() => void handleAssign()}>
              {state === "sending" ? "Handing off…" : label}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

/* ── The two-exit panel (#231, from #172; the creator's side added later) ─────
   Two people on an LOI reach a point where they have exactly two ways to
   finish, and the row's quick-action slot is a fixed 116px that cannot hold two
   buttons. So both get one control that opens a small anchored panel with both
   exits in it, rather than one button on the row and the other move buried
   somewhere else.

   That asymmetry is what #172 was filed about. When the clean path is one tap
   and the other path is a hunt through a menu, the clean path is what gets
   pressed — a check that found problems tended to end as a silent Complete
   with a note nobody was required to write.

   Two callers today:

   - **`Checked`**, the checker's, on a claimed LOI (#231). `Good to go`
     completes it; `Needs fixes` sends it to corrections and REQUIRES a note.
     The trigger is deliberately not called `Complete`: it completes nothing on
     its own, so that label would lie about what pressing it does.
   - **`Fixed`**, the creator's, on a task in corrections. `Complete` closes it;
     `Send back to checker` returns it for a confirming look. Same shape,
     because it is the same moment from the other side — and the send-back used
     to be a hamburger entry, which made it the hard path for exactly the reason
     above.

   Why a panel and not two buttons: settled on #172 by building four variants
   and driving them live. Splitting the 116px slot and swapping the outcomes
   into it in place both read worse. Don't revisit.

   An exit may require a note, and when it does the panel takes a second stage
   rather than firing from the choice. The requirement is the server's — it
   refuses the move without one — so the composer exists to make the rule
   answerable, not to be the rule.

   Portaled and anchored like the hamburger menu and the share popover (#113,
   #122): `.task-card` keeps `overflow: hidden` for its rounded corners, so
   anything taller than a collapsed row has to leave the card.
   Escape is handled on the panel with `stopPropagation`, the SharePopover way
   rather than the menu's document listener — a note stage owns a textarea, and
   one keypress should close this panel and nothing else around it. */
const TWO_EXIT_PANEL_WIDTH = 232;

type PanelExit = {
  label: string;
  /* Ghost styling for the secondary exit. Which one is secondary is the
     caller's call: for the checker it is `Needs fixes`, for the creator it is
     the send-back. */
  ghost?: boolean;
  /* Present when this exit cannot be taken without a note. `prompt` heads the
     composer, `placeholder` carries the requirement (so the empty box itself
     says what is missing), and `blockedReason` is the sentence the server would
     refuse with, for the screen-reader path. */
  note?: { prompt: string; placeholder: string; blockedReason: string };
  run: (note?: string) => void;
};

const TwoExitPanel = ({
  triggerLabel,
  dialogLabel,
  exits,
  onBeforeAction
}: {
  triggerLabel: string;
  dialogLabel: string;
  exits: [PanelExit, PanelExit];
  /* The row's `acknowledgeUnread`, run on either exit — pressing a control on a
     row is reading it, the same as every other quick action. */
  onBeforeAction: () => void;
}) => {
  const [open, setOpen] = useState(false);
  /* `null` is the two-choice stage; an index is the note composer for that
     exit. Holding the exit rather than a boolean means the panel never has to
     work out which of the two it is collecting for. */
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const blockedId = useId();

  /* One place that puts the panel back to its opening state, so closing it and
     backing out of the note stage can't drift into leaving a stale draft
     behind. */
  const toChoice = useCallback(() => {
    setNoteFor(null);
    setNote("");
  }, []);

  /* The note stage is a good deal taller than the choice stage, so a panel that
     flipped up has to re-anchor when the composer appears. An outside click
     dismisses without taking focus: the click has already put focus where the
     person aimed it, and yanking it back to this row would undo that. */
  const { triggerRef, panelRef, style: panelStyle } = useAnchoredPanel<HTMLButtonElement>({
    open,
    align: "right",
    fallbackWidth: TWO_EXIT_PANEL_WIDTH,
    onDismiss: () => close(false),
    remeasureKey: noteFor
  });

  /* Closing by keyboard or by taking an exit hands focus back to the trigger.
     The panel is portaled to the body, so without this a keyboard user who
     opens it, presses Escape and carries on tabbing resumes from
     `document.body` — the top of the page, nowhere near the row they were
     working. */
  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    toChoice();
    if (focusTrigger) {
      triggerRef.current?.focus();
    }
  }, [toChoice, triggerRef]);

  useEffect(() => {
    if (open && noteFor !== null) {
      noteRef.current?.focus();
    }
  }, [open, noteFor]);

  const take = (exit: PanelExit, text?: string) => {
    onBeforeAction();
    close();
    exit.run(text);
  };

  const pending = noteFor === null ? undefined : exits[noteFor];
  const trimmed = note.trim();

  return (
    <span
      className="two-exit-panel"
      onClick={(e) => e.stopPropagation()}
      /* The panel is portaled out of the row in the DOM, but React events still
         travel the React tree — so a keypress inside it reaches the row's own
         handler, which treats Space and Enter as "toggle this card". That is
         how a space typed into the note composer collapsed the row instead of
         landing in the box (#231's visual pass). Keys raised anywhere in this
         control are this control's business; the panel handles its own Escape
         and the textarea its own text. */
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn-sm task-card-quick-action two-exit-panel-trigger"
        /* The disclosure affordance is these two attributes and nothing else.
           There was a `▾` next to the label; at this size and weight it
           rendered as a small dot rather than a triangle, and the user's ruling
           on the re-check was that it is neither visible nor necessary — the
           panel opening says what the glyph was trying to. It was `aria-hidden`
           anyway, so it was never carrying the meaning for anyone who could not
           see it; `aria-haspopup` and `aria-expanded` always were, and they
           stay. */
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((was) => !was); }}
      >
        {triggerLabel}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="two-exit-panel-panel"
          role="dialog"
          aria-label={dialogLabel}
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            /* Swallowed: this panel can sit inside a scrolled list with other
               Escape handlers above it, and a note stage's draft is this
               panel's business alone. */
            e.stopPropagation();
            close();
          }}
        >
          {pending === undefined ? (
            exits.map((exit, index) => (
              <button
                key={exit.label}
                type="button"
                className={`btn-sm two-exit-panel-exit${exit.ghost ? " btn-ghost" : ""}`}
                autoFocus={index === 0}
                onClick={() => (exit.note ? setNoteFor(index) : take(exit))}
              >
                {exit.label}
              </button>
            ))
          ) : (
            <>
              <span className="two-exit-panel-label">{pending.note!.prompt}</span>
              {/* The placeholder carries the requirement, so the empty box says
                  what is missing at the point the person is looking. There is
                  no separate explanatory sentence: one was tried and read as
                  noise beside a button that still looked pressable. The button
                  below is unmistakably disabled instead, and keeps the server's
                  own refusal on `aria-label` so the reason is still spoken. */}
              {/* Enter sends, Shift+Enter makes a newline — the same handler
                  idiom as every other note composer in this file (the fraud
                  note, the completed-task note, the thread reply). It briefly
                  did the opposite, on the argument that a finding can run to a
                  paragraph; the user's ruling is consistency with the rest of
                  the app, and Shift+Enter still gets them the second line.

                  `trimmed` is the same guard the button has, so the keyboard
                  path cannot send the empty note the pointer path refuses. */}
              <textarea
                ref={noteRef}
                className="two-exit-panel-note"
                rows={3}
                placeholder={pending.note!.placeholder}
                aria-label={pending.note!.prompt}
                aria-describedby={blockedId}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (trimmed) take(pending, trimmed); } }}
              />
              <span className="sr-only" id={blockedId}>{pending.note!.blockedReason}</span>
              <div className="two-exit-panel-actions">
                <button type="button" className="btn-sm btn-ghost" onClick={toChoice}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn-sm two-exit-panel-send"
                  disabled={!trimmed}
                  aria-label={trimmed ? undefined : `${pending.label} — ${pending.note!.blockedReason}`}
                  onClick={() => take(pending, trimmed)}
                >
                  {pending.label}
                </button>
              </div>
            </>
          )}
        </div>,
        document.body
      )}
    </span>
  );
};

/* ── Fraud outstanding-items checklist (#44) ──────────────────
   The structured handoff that replaces the old free-text outstanding-items
   surface on FRAUD checks. The checker builds the list, the requester resolves
   it (tick = collected OR not-needed, with an optional note), the checker
   reviews and approves or bounces. Stable add-order (#96); checking an item
   off never moves it.

   Two rules gate every affordance, both from shared so the UI can't drift from
   the server (which is still the authority): recording reality — tick, add,
   your own note — is open to both seats at any live status
   (`canEditChecklist`), while changing what's being asked — retext, delete —
   is scoped to the specific item (`canEditChecklistItemText`,
   `canDeleteChecklistItem`). */
/* Amending the ask (ADR-0006, extended by ADR-0008 rules 4 and 8). Four calls,
   never one patch — the same shape the server's four routes have, so the
   surface can't offer a field the rule doesn't cover. There is no due-date
   member and there is no due-date input: `dueAt` is derived from the urgency
   band server-side, or on an OOO task from the return date.

   `setPoints` is the only way the web app sets the poops: since #335 every
   rating the card draws is read-only, and the form is the one control.

   `setDates` takes both dates in one call because they are one range: the rule
   is that the start is on or before the return, which cannot be checked against
   half of itself. */
export interface AmendApi {
  setNotes: (taskId: string, notes: string) => Promise<void>;
  setUrgency: (taskId: string, urgency: UrgencyLevel) => Promise<void>;
  /* An OOO task's vacation description (#262). OOO only, and the server refuses
     anything else: every other type's folder name is its *loan's* name, held on
     the shared Loan record, and correcting it goes to `PATCH /loans/:loanId`
     instead so the fix lands on every task for that loan at once. There is
     therefore no member here for the folder name in general — the two fields
     have different owners, not one field with a special case. */
  setFolderName: (taskId: string, folderName: string) => Promise<void>;
  setPoints: (taskId: string, points: number) => Promise<void>;
  setDates: (taskId: string, dates: { startDate: string; returnDate: string }) => Promise<void>;
}

/* Reading a task's history (#166). One member, because the web app wants one
   answer out of it: when the current assignee took the task on. Fetched lazily
   when a card's hamburger opens rather than with the task list — the list can
   hold hundreds of rows and this is reference detail nobody reads on most of
   them.

   Unlike `AmendApi`, it swallows its failures and resolves to `undefined`. A
   timestamp behind a menu is not worth a toast, and the two lines above it must
   keep rendering either way. `undefined` is "could not read", distinct from an
   empty list, which is "this task has no history" — the caller shows nothing for
   both but only retries the first. */
export interface TaskHistoryApi {
  read: (taskId: string) => Promise<TaskHistoryEvent[] | undefined>;
}

export interface ChecklistApi {
  addItem: (taskId: string, text: string) => Promise<void>;
  editText: (taskId: string, itemId: string, text: string) => Promise<void>;
  deleteItem: (taskId: string, itemId: string) => Promise<void>;
  toggle: (taskId: string, itemId: string, checked: boolean, note?: string) => Promise<void>;
  /* One call, one endpoint. The server decides which field it writes from the
     caller's seat, so there is nothing here to pick. */
  setNote: (taskId: string, itemId: string, note: string) => Promise<void>;
}

/* Whose requirement is this? `addedBy` records the seat that asked for the
   item, so it resolves to one of the task's two people. Not who ticked it —
   that isn't stored (deliberately out of scope in #137), and the chip would be
   lying if it implied otherwise.

   The checker seat can be vacant — a released Fraud Check has items but no
   assignee — so the name is optional and the chip falls back to a neutral
   placeholder rather than guessing. */
const checklistAdder = (task: LoanTask, addedBy: ChecklistItem["addedBy"]): { id?: string; name?: string; seat: string } =>
  addedBy === "checker"
    ? { ...(task.assignee ? { id: task.assignee.id, name: task.assignee.displayName } : {}), seat: "the file checker" }
    : { id: task.createdBy.id, name: task.createdBy.displayName, seat: "the requester" };

/* The adder's initials chip. Same `avatarStyle` hash as the card header's
   assigner/assignee pair, so a person is one colour everywhere and the mapping
   is learned once — there are only ever two people on a task, so it reads as
   two colours rather than a palette. */
const ChecklistAdderChip = ({ task, addedBy }: { task: LoanTask; addedBy: ChecklistItem["addedBy"] }) => {
  const adder = checklistAdder(task, addedBy);
  const label = adder.name ? `Added by ${adder.name}` : `Added by ${adder.seat}`;
  return (
    <span
      className={`checklist-adder${adder.id ? "" : " checklist-adder-none"}`}
      style={adder.id ? avatarStyle(adder.id) : undefined}
      title={label}
      aria-label={label}
    >
      {initialsOf(adder.name)}
    </span>
  );
};

const FraudChecklist = ({ task, user, api }: { task: LoanTask; user: UserIdentity; api: ChecklistApi }) => {
  const [newItem, setNewItem] = useState("");
  /* One inline editor open at a time: which item, and text or note. There is no
     "whose note" here — a viewer holds one seat or none, and writes that one. */
  const [active, setActive] = useState<{ id: string; kind: "text" | "note" } | null>(null);
  const [draft, setDraft] = useState("");

  const items = task.checklist ?? [];
  const sorted = sortChecklist(items);
  /* The submit gate (#184) says nothing here. It is the card's disabled Submit
     button and its tooltip, and nothing else: not a sentence over the list
     (#317), not a count under the button and not a tint on the rows it is
     waiting for (#321, #323). The list is the ask, and a list does not need
     three things introducing it. Who may submit and when is still the shared
     action set's answer, asked where the button is drawn. */

  /* Recording reality — tick, add, write your own note — is one grant, held by
     both seats at any live status. */
  const canRecord = canEditChecklist(task, user);
  /* Which seat the viewer holds decides which note field the row offers, and
     therefore how many "+ note" buttons it can show: exactly one, or none. */
  const seat = checklistSeat(task, user);

  const openEditor = (id: string, kind: "text" | "note", seed: string) => {
    setActive({ id, kind });
    setDraft(seed);
  };
  const closeEditor = () => { setActive(null); setDraft(""); };
  const saveEditor = async (item: ChecklistItem) => {
    if (!active) return;
    const value = draft.trim();
    if (active.kind === "text") {
      if (value && value !== item.text) await api.editText(task.id, item.id, value);
    } else {
      await api.setNote(task.id, item.id, value);
    }
    closeEditor();
  };

  const addItem = async () => {
    const value = newItem.trim();
    if (!value) return;
    setNewItem("");
    await api.addItem(task.id, value);
  };

  /* The same ruled page as the instructions box (#367): the label in the left
     margin cell, everything else in the body cell right of the hairline. Two
     cells, so the grid `.loi-terms` shares with `.checklist` lays both out. */
  return (
    <div className="checklist">
      <div className="checklist-head">
        <span className="checklist-title">Outstanding items</span>
      </div>

      <div className="checklist-body">
        {sorted.length > 0 && (
          <ul className="checklist-items">
            {sorted.map((item) => {
              const editingText = active?.id === item.id && active.kind === "text";
              /* Per item, not per status: your own not-yet-handed-off item is
                 yours to retype, and the checker may re-ask a committed one
                 (which uncheck+stales it). */
              const canEditText = canEditChecklistItemText(task, user, item);
              /* The viewer's own note on this item, whichever field that is —
                 what the single "+ note" button offers when it's missing. Which
                 field belongs to which seat is shared's to know, not the view's. */
              const ownNote = ownChecklistNote(item, seat);
              const editingNote = active?.id === item.id && active.kind === "note";
              return (
                <li key={item.id} className={`checklist-item${item.checked ? " checklist-item-done" : ""}${item.stale ? " checklist-item-stale" : ""}`}>
                  <div className="checklist-item-main">
                    <button
                      type="button"
                      className={`checklist-check${item.checked ? " checklist-check-on" : ""}`}
                      role="checkbox"
                      aria-checked={item.checked}
                      aria-label={item.checked ? `Mark "${item.text}" unresolved` : `Mark "${item.text}" resolved`}
                      disabled={!canRecord}
                      onClick={() => { if (canRecord) void api.toggle(task.id, item.id, !item.checked); }}
                    >
                      {item.checked && <CheckIcon />}
                    </button>

                    <ChecklistAdderChip task={task} addedBy={item.addedBy} />

                    {editingText ? (
                      <input
                        className="checklist-item-input"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveEditor(item); }
                          if (e.key === "Escape") closeEditor();
                        }}
                        onBlur={() => void saveEditor(item)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="checklist-item-text"
                        disabled={!canEditText}
                        title={canEditText ? "Edit item" : undefined}
                        onClick={() => { if (canEditText) openEditor(item.id, "text", item.text); }}
                      >
                        {item.text}
                      </button>
                    )}

                    <span className="checklist-badges">
                      {item.stale && <span className="checklist-badge checklist-badge-stale" title="Text changed after it was checked — re-verify">stale · re-verify</span>}
                    </span>

                    {/* Gated delete (#66): only for a fresh item you added, on your
                        own turn, before it's handed off. Locks once submitted /
                        sent / bounced. */}
                    {canDeleteChecklistItem(task, user, item) && (
                      <button
                        type="button"
                        className="checklist-delete"
                        title="Delete this item (only until you hand it off)"
                        aria-label={`Delete "${item.text}"`}
                        onClick={() => void api.deleteItem(task.id, item.id)}
                      >
                        <TrashIcon />
                      </button>
                    )}

                    {/* Exactly ONE "+ note" per row: the viewer's own seat's
                        field, and none at all for a viewer holding no seat. There
                        were two identical buttons here, one per field, and a
                        viewer who satisfied both seat predicates saw both — which
                        is how someone could write a note in the other person's
                        name. The label stays "+ note" either way; "checker note"
                        wasn't worth differentiating when you only ever have one.

                        It rides inline at the end of the item's own row (not a
                        separate line below), saving a line per item that has no
                        note yet. Once the note exists it moves to its full row
                        below — a real note needs the room. */}
                    {canRecord && !editingNote && !ownNote && (
                      <button type="button" className="checklist-note-add" onClick={() => openEditor(item.id, "note", "")}>+ note</button>
                    )}
                  </div>

                  {/* Both seats' notes are shown when present — a fraud record you
                      can only half-read is no record — but only your own is
                      clickable, and the editor writes only your own field. Each
                      keeps the author's full name rather than a chip: a sentence
                      stays attributed to a person. */}
                  {(editingNote || item.note || item.checkerNote) && (
                    <div className="checklist-item-notes">
                      {editingNote ? (
                        <div className="checklist-note-edit">
                          <input
                            className="checklist-item-input"
                            placeholder={seat === "checker" ? "Why this isn't sufficient / needs rework…" : "Why it's not needed / how it was handled…"}
                            value={draft}
                            autoFocus
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEditor(item); } if (e.key === "Escape") closeEditor(); }}
                            onBlur={() => void saveEditor(item)}
                          />
                        </div>
                      ) : null}

                      {!(editingNote && seat === "creator") && item.note ? (
                        <button
                          type="button"
                          className="checklist-note checklist-note-creator"
                          disabled={!(canRecord && seat === "creator")}
                          onClick={() => { if (canRecord && seat === "creator") openEditor(item.id, "note", item.note ?? ""); }}
                        >
                          <b>{task.createdBy.displayName}:</b> {item.note}
                        </button>
                      ) : null}

                      {!(editingNote && seat === "checker") && item.checkerNote ? (
                        <button
                          type="button"
                          className="checklist-note checklist-note-checker"
                          disabled={!(canRecord && seat === "checker")}
                          onClick={() => { if (canRecord && seat === "checker") openEditor(item.id, "note", item.checkerNote ?? ""); }}
                        >
                          <b>{task.assignee?.displayName ?? "Checker"}:</b> {item.checkerNote}
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Flush on an empty list, the way the create form's seeder does it:
            the dashed divider separates the composer from items above it, and
            with none it would be a stray rule at the top of the body cell. */}
        {canRecord && (
          <div className={`checklist-add${sorted.length > 0 ? "" : " checklist-add-flush"}`}>
            <input
              className="checklist-item-input"
              placeholder="Add an item, press Enter…"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addItem(); } }}
            />
            <button type="button" className="btn-sm" onClick={() => void addItem()} disabled={!newItem.trim()}>Add</button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Task Card ────────────────────────────────────────────── */
/* Memoized so non-card App state changes — most notably the 30s `now` ticker
   (#73) — re-render only the cards whose props actually changed. This bites
   only because every prop below is referentially stable: the ~10 handlers and
   `checklistApi` are `useCallback`/`useMemo`-wrapped in App, and the rest are
   primitives or already-stable values (see the `cardProps` object). Adding an
   unstable prop here silently defeats the memo. */
const TaskCard = memo(({
  task,
  user,
  onClaim,
  onUnclaim,
  onReturnToPool,
  onTransition,
  onRelease,
  onAddReviewNote,
  onEditMessage,
  onDeleteMessage,
  onSaveInstructions,
  onAddCompletedNote,
  onEditTask,
  taskHistory,
  onShare,
  onAssign,
  checklist,
  directory,
  teamsAppId,
  showActions,
  seenNoteAt,
  onMarkNoteSeen,
  pulsing,
  expandOverride,
  courtHeld,
  onSetExpand,
  now
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onReturnToPool: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onRelease: (taskId: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  /* Correct a message you posted (#287, ADR-0009). Addressed by the message's
     own identifier, not its position: the thread hands back what it was given,
     and the server is the one that decides whether the author may. */
  onEditMessage: (taskId: string, messageId: string, text: string) => Promise<void>;
  /* Withdraw a message you posted (#288, ADR-0009 rule 4). One way and no
     payload: the thread hands back the identifier it was given, and the server
     decides whether the author may. */
  onDeleteMessage: (taskId: string, messageId: string) => Promise<void>;
  /* Save the Instructions box from the box itself (#303, ADR-0010 rule 4). The
     same route the edit form's save reaches, so the two doors onto this one
     field cannot produce different results. */
  onSaveInstructions: (taskId: string, text: string) => Promise<void>;
  /* Append a note to an already-COMPLETED task (#45). Server keeps the task
     COMPLETED — no visible reopen. */
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  /* Open the edit form on this task (#260). App owns the form and the save, so
     the row hands over an id and nothing else — a card that held the draft
     would lose it on every list refresh. */
  onEditTask: (taskId: string) => void;
  /* Reading this task's history, for the menu's "Claimed" line (#166). Called
     on menu open, never on list load. */
  taskHistory: TaskHistoryApi;
  /* FRAUD structured checklist ops (#44). */
  checklist: ChecklistApi;
  /* Point a specific person at this task (issue #41). Resolves with whether the
     DM actually reached them; rejects on request failure so the card can show
     inline status. */
  onShare: (taskId: string, targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  /* Hand the task to someone else (ADR-0002). Rejects with the server's message
     so the popover can show the refusal inline. */
  onAssign: (taskId: string, assigneeUserId: string, note?: string) => Promise<void>;
  /* Selectable people for the share and handoff pickers (active users). The
     handoff picker needs roles too, so this is DirectoryUser rather than a bare
     id/name pair. */
  directory: DirectoryUser[];
  /* Teams app id from GET /api/config, or null when the server has no
     TEAMS_APP_ID. Drives whether "Copy link" copies a Teams deep link. */
  teamsAppId: string | null;
  showActions: boolean;
  seenNoteAt?: string;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsing?: boolean;
  /* Per-user persisted manual open/close. undefined = follow the default. */
  expandOverride?: boolean;
  /* True while this row is pinned to "Needs you" by a court hold
     (court-latch.ts). The slot needs it for the same reason the section
     builder does: to say why the row is here after the red dot has gone. */
  courtHeld?: boolean;
  onSetExpand?: (taskId: string, open: boolean, pulled?: boolean) => void;
  /* Ticking clock (ms) for the row's live countdown. */
  now?: number;
}) => {
  const [noteText, setNoteText] = useState("");
  /* "Add a note" on a COMPLETED card (#45): the button reveals an inline field
     whose text posts to the server-atomic completed-note endpoint (task stays
     COMPLETED). `completedNoteOpen` toggles the field; `completedNote` is the
     draft. */
  const [completedNoteOpen, setCompletedNoteOpen] = useState(false);
  const [completedNote, setCompletedNote] = useState("");
  /* Actions menu: everything but the row's one primary action and FRAUD's
     forward moves lives behind this hamburger, next to the primary action
     in the collapsed row's action cell — open regardless of whether the
     row itself is expanded. */
  const [menuOpen, setMenuOpen] = useState(false);
  /* The task's history, for the lines of the menu's timestamp block that are
     read back out of it rather than stored on the task: when the current
     assignee took it (#166) and who closed it (#239).

     Kept against a key naming everything the answers depend on — the assignee
     and the closed status — so a handoff or a close while the card is mounted
     can't leave the previous answer sitting under the new name. A stale answer
     here is a misattribution, not a cosmetic lag.

     Per-card, per-mount, and deliberately without an invalidation scheme:
     ADR-0005 declined to persist the claim instant precisely because it is
     reference detail behind a menu, and the closer is the same kind of thing. */
  const [menuHistory, setMenuHistory] = useState<{ key: string; events: TaskHistoryEvent[] } | undefined>(undefined);
  const menuHistoryInFlight = useRef<string | undefined>(undefined);
  /* Two-step cancel: confirm row → 1s "Cancelled" flash → server refresh
     drops the task from the grid since cancelled rows are filtered out. */
  const [cancelStage, setCancelStage] = useState<"idle" | "confirming" | "done">("idle");
  /* The terminal quick action awaiting its confirm, or null. Same two-step as
     `cancelStage` and in the same place — the menu panel — because a press that
     ends a record should ask once, and the app already had exactly one way of
     asking that on a row. Cancel could not simply be reused: it is a fixed
     question about a fixed transition, and this one has to name whichever of
     Complete / Confirm / Approve / Archive was pressed. */
  const [pendingTerminal, setPendingTerminal] = useState<{ label: string; run: () => void } | null>(null);
  useEffect(() => {
    if (cancelStage !== "done") return;
    const id = setTimeout(() => setCancelStage("idle"), 1200);
    return () => clearTimeout(id);
  }, [cancelStage]);
  /* Closing the menu withdraws the terminal question with it. Outside press and
     Escape are dismissals, and a dismissal must not leave a pending Archive
     armed to fire the next time the panel opens. */
  const closeMenu = useCallback(() => { setMenuOpen(false); setPendingTerminal(null); }, []);
  const assigneeId = task.assignee?.id;
  /* Deliberately narrower than the component's `isClosed` (`CLOSED_STATUSES`),
     which also covers `CANCELLED`: a cancellation is the creator calling the
     request off, and there is no closure row and nobody to name. */
  const hasCloserToName = task.status === "COMPLETED" || task.status === "ARCHIVED";
  /* Everything the fetched history is asked about. A change to any of it makes
     the held answer somebody else's, so it re-fetches rather than re-labels. */
  const historyKey = `${assigneeId ?? ""}|${hasCloserToName ? task.status : ""}`;
  const wantsHistory = Boolean(assigneeId) || hasCloserToName;
  /* Fetch the history when the menu opens and it has something to answer (#166,
     #239). Keyed on `menuOpen` rather than hung off the hamburger's onClick
     because the collapsed row's cancel shortcut opens the panel too, and an
     onClick handler would leave that door without the lines.

     One request per key per mount: an answered key short-circuits, and an
     in-flight one is guarded by a ref so a quick close-and-reopen can't fire a
     second. A read that failed records nothing, so the next open retries — the
     cost of a retry is one GET, and the cost of not retrying is a line that
     stays missing for as long as the card lives. An empty history is an answer,
     not a failure, and is recorded as one.

     The in-flight ref is cleared only by the request that set it: a handoff
     mid-flight starts a second request, and the first one landing afterwards
     must not clear the guard the second is relying on.

     Nothing here awaits the render: the first two timestamp lines are already
     on screen, and these appear underneath them when the answer lands. */
  useEffect(() => {
    if (!menuOpen || !wantsHistory) return;
    if (menuHistory?.key === historyKey) return;
    if (menuHistoryInFlight.current === historyKey) return;
    menuHistoryInFlight.current = historyKey;
    let live = true;
    void taskHistory.read(task.id).then((events) => {
      if (menuHistoryInFlight.current === historyKey) menuHistoryInFlight.current = undefined;
      if (live && events) setMenuHistory({ key: historyKey, events });
    });
    return () => {
      live = false;
    };
  }, [menuOpen, wantsHistory, historyKey, task.id, taskHistory, menuHistory]);
  /* Only ever the answer for the task as it is on the card right now. */
  const answeredHistory = menuHistory && menuHistory.key === historyKey ? menuHistory.events : undefined;
  const claimedAt = assigneeId && answeredHistory ? currentAssigneeSince(answeredHistory) : undefined;
  /* Who actually closed it, which since ADR-0007 is not always the assignee.
     Absent — not guessed from the assignee — on any task whose closure predates
     the named history row. */
  const completer = hasCloserToName && answeredHistory ? completedBy(answeredHistory) : undefined;
  const archiver = task.status === "ARCHIVED" && answeredHistory ? archivedBy(answeredHistory) : undefined;
  /* The panel is portaled to document.body and fixed-positioned from the
     hamburger's rect (#122) — as an absolutely-positioned descendant it was
     clipped away by `.task-card`'s `overflow: hidden`, which on a collapsed row
     cut off all but an ~8px sliver.

     Right-aligned: the hamburger sits to the LEFT of the primary action button,
     so a left-anchored panel would drift under it and off the card's right edge.
     The remeasure key is the confirm row's stage plus every line the fetched
     history feeds: the confirm row and the "Cancelled ✓" flash swap the panel's
     contents, and "Claimed" (#166) and "Completed by" / "Archived by" (#239)
     arrive after open — each changes the panel's height, which moves where an
     up-flipped panel has to sit. The share popover the menu hosts is portaled to
     the body too, so it needs the outside-click exemption: without it, picking a
     person would close the menu and take the popover down with it. */
  const { triggerRef: menuTriggerRef, panelRef: menuPanelRef, style: menuPanelStyle } =
    useAnchoredPanel<HTMLButtonElement>({
      open: menuOpen,
      align: "right",
      fallbackWidth: MENU_PANEL_WIDTH,
      onDismiss: closeMenu,
      remeasureKey: `${cancelStage}:${claimedAt ?? ""}:${completer?.id ?? ""}:${archiver?.id ?? ""}`,
      keepOpenWithin: ".share-pop-panel"
    });
  /* Escape closes the menu (#122 — it had no dismissal at all). Focus is
     usually still on the row, so this listens on the document rather than the
     panel. Two exemptions, both for Esc handlers that already live inside the
     panel and would otherwise fire together with this one: the share popover,
     and any text field in the panel (the "Add a note" composer clears its draft
     on Esc — losing the draft AND the menu in one keypress is not the ask). */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".share-pop-panel")) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && menuPanelRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, closeMenu, menuPanelRef]);
  const isAssignee = task.assignee?.id === user.id;
  const isCreator = task.createdBy.id === user.id;
  /* Who may attach a review note. The shared predicate, not a local copy of the
     rule — the server gates on the same one, so the composer and the API can't
     drift. Reused by the active composer (canPostNote) and the completed-card
     "Add a note" gate (#45). */
  const canNoteTask = canAddNoteToTask(task, user);
  /* The note waiting on this viewer, if any — the shared rule, not a local
     copy, so the card's red dot and the grouped view's message-pull can't
     disagree about who deserves a nudge. It gates on party membership: an
     Observer has acknowledged nothing, so under a bare note check every note
     on the list read as unread at them (#161). The timestamp comes back with
     the answer because acknowledging writes back the very note we counted. */
  const unreadNoteAt = unreadNoteFor(task, user, seenNoteAt);
  const hasUnreadNote = unreadNoteAt !== undefined;
  /* Cards do not open or close themselves. Every card starts collapsed and
     stays that way until the viewer expands it, and nothing shuts it again
     but them.

     There used to be a default-open rule — OPEN for everyone, an unread note,
     your own in-flight work — paired with an effect that cleared the manual
     override on a status change or a new note so the rule could re-apply. The
     combination meant the list rearranged itself under you: cards you had
     opened snapped shut, cards you had never touched sprang open. The
     collapsed row already carries the quick action and the hamburger, so
     nothing you need is behind the fold, and the red dot says where to look
     without taking the decision off you.

     The one-liner lives in expand-state.ts because the list header's Collapse
     all (#177) reads the same map from the other side, and one owner of the
     rule is what keeps the button from claiming there is something to collapse
     when there isn't. */
  const expanded = isTaskExpanded(expandOverride);
  /* The third argument answers "is the message pull what put this row where it
     is", which decides whether opening it takes a court hold. The card is the
     one that knows, and telling App keeps App's callback free of `tasks` — see
     `setExpandOverride`. Read at render, so it is the state at the press. */
  const setExpanded = (open: boolean): void => onSetExpand?.(task.id, open, hasUnreadNote);
  /* Acknowledge an unread note: clears the undim lock and the red dot.
     Triggered by an explicit user gesture (header click/key, or sending
     a reply). */
  const acknowledgeUnread = (): void => {
    if (unreadNoteAt && onMarkNoteSeen) {
      onMarkNoteSeen(task.id, unreadNoteAt);
    }
  };
  /* Auto-scroll the notes thread to the newest entry whenever the count grows
     or the card opens. */
  const reviewListRef = useRef<HTMLDivElement | null>(null);
  const reviewCount = task.reviewNotes?.length ?? 0;
  useEffect(() => {
    const el = reviewListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reviewCount, expanded]);
  const transitions = nextFlowStatuses(task).filter((s) => s !== "OPEN");
  // Non-undefined only for a reopened task; the exact closed status to restore
  // it to (COMPLETED/ARCHIVED). Permission mirrors the shared canRestoreTask.
  const restoreTarget = restoreTargetStatus(task);

  const handleSubmitNote = async () => {
    if (!noteText.trim()) return;
    await onAddReviewNote(task.id, noteText.trim());
    setNoteText("");
    acknowledgeUnread();
  };

  /* Submit the COMPLETED-card note (#45). One gesture: post, clear, close the
     field; the task stays COMPLETED (the server handles the atomic append). */
  const submitCompletedNote = async () => {
    if (!completedNote.trim()) return;
    acknowledgeUnread();
    await onAddCompletedNote(task.id, completedNote.trim());
    setCompletedNote("");
    setCompletedNoteOpen(false);
  };

  /* The thread's edit handler, bound to this task (#287). No
     `acknowledgeUnread` here, unlike every other write on this card: correcting
     your own sentence is not reading somebody else's, and the unread signal
     belongs to a message from the other party. */
  const editMessage = useCallback(
    (messageId: string, text: string): Promise<void> => onEditMessage(task.id, messageId, text),
    [onEditMessage, task.id]
  );

  /* And the delete handler beside it (#288), bound the same way and for the
     same reason: no `acknowledgeUnread` either. Withdrawing your own sentence
     is not reading somebody else's. */
  const deleteMessage = useCallback(
    (messageId: string): Promise<void> => onDeleteMessage(task.id, messageId),
    [onDeleteMessage, task.id]
  );

  /* And the Instructions box's save (#303), bound the same way. No
     `acknowledgeUnread`: correcting the ask you filed is not reading somebody
     else's message. */
  const saveInstructions = useCallback(
    (text: string): Promise<void> => onSaveInstructions(task.id, text),
    [onSaveInstructions, task.id]
  );

  /* Share: point one person at this task. Candidates exclude the current user
     plus the creator and assignee — they already see the task, so the picker
     only offers genuinely new recipients (issue #41). */
  const shareCandidates = directory.filter(
    (p) => p.id !== user.id && p.id !== task.createdBy.id && p.id !== task.assignee?.id
  );
  /* Handoff candidates (ADR-0002) — a deliberately different set from share's.
     Everyone eligible to work this task except three people: you, the creator
     (ADR-0003), and whoever currently holds it (#208).

     None of them is a special case here — the row carries no copy of any of
     those rules. `canAssignTaskTo` is the same predicate the server enforces, so
     the picker cannot route around a door the server would shut.

     You are missing from your own picker because handing yourself a task is how
     people used to take over work somebody had claimed and stalled on. That is
     now the creator's move rather than the taker's: they put it back in the pool
     and anyone claims it from there, in the open. */
  const assignCandidates = directory.filter((p) =>
    canAssignTaskTo(task, { id: p.id, displayName: p.displayName, roles: p.roles }, user)
  );
  /* Two links to this task:
     - `webShareLink` — the plain browser URL. The `#task-<id>` fragment is
       parsed on boot and fed to the focus mechanism, so it expands + scrolls
       to the row. Pasted into Teams it opens a browser and hits the SSO wall,
       which is why it is no longer the default copy target.
     - `shareLink` — the Teams deep link, built by the same shared builder the
       bot uses, carrying the folder name as `label` (so the link unfurls
       readably in a chat) and this origin as `webUrl` (where to send someone
       with no Teams client). Falls back to the web URL when the server has no
       TEAMS_APP_ID (local dev). */
  const webShareLink = `${window.location.origin}${window.location.pathname}#task-${task.id}`;
  const shareLink =
    teamsTaskDeepLink(teamsAppId, task.id, { label: task.folderName, webUrl: window.location.origin }) ??
    webShareLink;

  const isClosed = CLOSED_STATUSES.includes(task.status);
  /* Observer = not a Party (CONTEXT.md). The shared predicate, so "who has a
     stake in this task" is stated once and the dim rule can't drift from the
     unread rule that sits next to it. */
  const isObserver = !isTaskParty(task, user);
  /* "Celebrating" = the creator just hit a completion milestone
     (COMPLETED, or LOAN_DOCS MERGE_DONE). Stays celebrating until the
     creator archives the task (or it falls back to an earlier status). */
  const isCelebrating =
    isCreator &&
    (task.status === "COMPLETED" || (task.taskType === "LOAN_DOCS" && task.status === "MERGE_DONE"));
  /* Dim rule:
     - OPEN → always bright (anyone may claim).
     - Attached (creator or assignee), in-flight → bright (it's your work).
     - Closed (completed/cancelled/archived) → dim, even if attached.
     - Observer, in-flight → dim (not your task).
     - Celebrating card and unread notes override → stay bright. */
  const dimmed = !hasUnreadNote && !isCelebrating && task.status !== "OPEN" && (
    isClosed || isObserver
  );
  /* Mini = closed bottom-bucket row. Celebrating COMPLETED renders as a
     full-size pulsing card at the top until the creator archives it. */
  const mini = isClosed && !isCelebrating;
  /* The grouped ("courts") row is deliberately mono, and this list is the whole
     of it. The court section already says whose court the task is in, and the
     due stamp says its lateness in words and in red, so the row carries only
     the dim, mini and celebrating-pulse signals.

     Nothing here paints a card edge, and nothing in `styles.css` would if it
     did: the status, closed-backdrop and own/watching rules that used to sit
     unemitted behind this list were deleted on 2026-09-06. A new row-level
     state does not get an edge — see "one edge, one meaning" in
     `apps/web/CLAUDE.md`. */
  const cardClass = [
    "task-card",
    "task-card-grouped-wrap",
    expanded ? "task-card-grouped-open" : "",
    dimmed ? "task-card-dimmed" : "",
    mini ? "task-card-mini" : "",
    pulsing ? "task-card-celebrating" : ""
  ].filter(Boolean).join(" ");

  const handleHeaderClick = () => {
    acknowledgeUnread();
    setExpanded(!expanded);
  };
  const handleHeaderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    acknowledgeUnread();
    setExpanded(!expanded);
  };
  const stopBubble = (e: ReactMouseEvent) => e.stopPropagation();

  /* Tooltip for the due cell and the timestamp block at the foot of the row's
     hamburger, both off `taskTimeMeta` so they agree on every status by
     construction. The tooltip drops the OOO case (see `inTooltip` there); the
     block shows it. */
  const timeMeta = taskTimeMeta(task);
  const dueTitle = timeMeta?.inTooltip ? `${timeMeta.label} ${timeMeta.value}` : undefined;
  const urgencyTitle = task.taskType !== "OOO" ? `Urgency: ${URGENCY_TIMEFRAMES[task.urgency]}` : undefined;

  /* FRAUD two-phase role-aware buttons (#39), shared with the bot cards so both
     surfaces show the same set. Empty for non-FRAUD. `fraudQuick` is the phase's
     one forward move, promoted to the collapsed quick-action slot; the leftovers
     (Send Back, Release) live in the expanded body. */
  /* `noteCapable: false` — this app has no free-text box on a fraud move any
     more (2026-09-07). The outstanding items are the checklist and anything
     else the checker wants to say is a message in the conversation beside it,
     so a third place to type was one too many. Shared answers the empty-list
     case with a blocked button instead of a composer. The bot keeps its note
     path: an Adaptive Card has a text input and no way to build a list. */
  const fraudActions = fraudCardActions(task, user, { noteCapable: false });
  /* Prefer the plain one-tap move (Submit / Approve). Falling back to the
     note-required one is what puts `Send Items` in the row on a CLAIMED check,
     where the checker has no plain move and the slot otherwise sat empty while
     the real next step hid in the body in a different colour. The fallback only
     ever fires in that phase — PENDING_APPROVAL pairs `Send Back` with a plain
     `Approve`, so Approve keeps the slot and Send Back keeps the body. */
  const fraudQuick =
    fraudActions.find((a) => a.kind === "transition") ??
    fraudActions.find((a) => a.kind === "transitionWithNote");
  /* The promoted move already rides the collapsed row (#97) — don't render its
     button a second time in the hamburger. */
  const expandedFraudActions = fraudActions.filter((a) => a !== fraudQuick);
  /* `blockedReason` is set when the move is the phase's forward step but the
     task's state won't take it yet — today only Submit, held until every
     checklist item is checked or noted (#184). Same sentence the server's
     refusal would carry, so the button doesn't teach a different rule. */
  /* `terminal` marks a press that ENDS the record — Complete, Confirm, the
     fraud Approve, Archive. It drives two things and only these two: the
     button's tier (see `quickActionClass`) and whether the press asks first.
     Deliberately not `kind`: every branch below already sets `kind: "good"`,
     including the ones that close a task, so the existing field cannot answer
     this question without being redefined under every caller. */
  type QuickAction = { label: string; kind: "good" | "ghost" | "danger" | "default"; run: () => void; blockedReason?: string; terminal?: boolean };
  let primaryAction: QuickAction | null = null;
  /* The LOI checker's two exits (#231). Set only on a claimed LOI, for the
     checker holding it, and only when the server would accept BOTH moves —
     `canUseCheckedPanel` asks `canTransitionStatus` for both and answers once,
     so the panel can never be drawn with a dead half. When it is set the slot
     hosts the panel instead of a button, and the Complete branch below stands
     down: on this one cell `Checked` IS the Complete branch, wearing the name
     that tells the truth about what pressing it does. Everywhere else the
     ladder is byte-for-byte what it was. */
  const showCheckedPanel = showActions && !mini && canUseCheckedPanel(task, user);
  /* The creator's two exits from corrections, once they have made the fix — the
     same control from the other side of the loop. `Complete` used to sit on the
     row while `Send back to checker` was a hamburger entry, which made one of
     their two moves easy and the other a hunt; that is the asymmetry #172 was
     filed about, arriving on the creator's side. Same standing-down rule: when
     this is set the Complete branch below leaves the slot to it. */
  const showFixedPanel = showActions && !mini && canUseFixedPanel(task, user);
  const twoExitPanel = showCheckedPanel || showFixedPanel;
  if (showActions) {
    // `canClaimTask` owns the whole rule, status included: OPEN, plus a FRAUD
    // task sitting in the pool with no assignee at whatever status it was
    // released at. The row used to re-state the released case and drifted.
    if (canClaimTask(task, user)) {
      primaryAction = { label: ACTION_LABELS.CLAIM, kind: "good", run: () => { void onClaim(task.id); } };
    } else if (fraudQuick && fraudQuick.targetStatus) {
      const target = fraudQuick.targetStatus;
      /* One tap. `Send Items` with an empty checklist used to open the card and
         reveal a composer here; it is now blocked by `blockedReason` like
         `Submit` is, and the slot's own click handler opens the card so the
         checker lands on the list they need to fill in. */
      primaryAction = {
        label: fraudQuick.label,
        kind: "good",
        terminal: CLOSED_STATUSES.includes(target),
        run: () => { void onTransition(task.id, target); },
        /* Both carried through under the names shared gives them — the count
           rides alongside the sentence rather than being recomputed here, so the
           narrow action column can't disagree with the tooltip beside it. */
        ...(fraudQuick.blockedReason
          ? { blockedReason: fraudQuick.blockedReason }
          : {})
      };
    } else if (canMarkMergeDone(task, user) && transitions.includes("MERGE_DONE")) {
      primaryAction = { label: ACTION_LABELS.MERGE_DONE, kind: "good", run: () => { void onTransition(task.id, "MERGE_DONE"); } };
    } else if (!twoExitPanel && (task.status === "CLAIMED" || task.status === "NEEDS_REVIEW") && canTransitionStatus(task, "COMPLETED", user).ok) {
      /* Complete, gated by the exact question the server asks on the click —
         not by a neighbouring predicate. On NEEDS_REVIEW (#118, the LOI
         corrections state) the row used to read `canMoveNeedsReview`, which
         admitted the creator, while the server enforced completion, which did
         not: the creator was shown a button that answered with an error toast
         (#236). Since ADR-0007 the button is the creator's and the server
         agrees, and reading `canTransitionStatus` here means the two cannot
         disagree again whatever the rule becomes. Returning a corrections task
         to the assignee stays in the hamburger. Sits below the CLAIMED cases
         and above MERGE_DONE: the statuses are mutually exclusive, so it
         neither shadows nor is shadowed.

         One request, whichever of the two presses this is (#238). The confirm
         at the tail of the corrections loop archives as well as completes, and
         the server does both in one write off the same COMPLETED transition —
         firing ARCHIVED after it from here is what could leave a task completed
         and not archived when the second call fails. The row only changes the
         word on the button, from `isConfirmingLook`, so it doesn't promise a
         plain completion and then file the task away. */
      primaryAction = {
        label: isConfirmingLook(task) ? ACTION_LABELS.CONFIRM : ACTION_LABELS.COMPLETE,
        kind: "good",
        terminal: true,
        run: () => { void onTransition(task.id, "COMPLETED"); }
      };
    } else if (canApproveMerge(task, user)) {
      primaryAction = { label: ACTION_LABELS.APPROVE_MERGE, kind: "good", run: () => { void onTransition(task.id, "MERGE_APPROVED"); } };
    } else if (task.status === "MERGE_APPROVED" && canCompleteTask(task, user)) {
      primaryAction = { label: ACTION_LABELS.COMPLETE, kind: "good", terminal: true, run: () => { void onTransition(task.id, "COMPLETED"); } };
    } else if (task.status === "COMPLETED" && isCreator) {
      primaryAction = { label: ACTION_LABELS.ARCHIVE, kind: "ghost", terminal: true, run: () => { void onTransition(task.id, "ARCHIVED"); } };
    }
    /* Re-open is intentionally NOT a quick-action — it lives in the
       expanded body. Closed mini rows show Archive (creator-only) or
       nothing; clicking the row expands to reveal Re-open. */
  }
  /* TWO tiers, and deliberately not more. The slot used to carry one style for
     every action regardless of kind, on the argument that it is always "the
     row's one next-step action" — and against a good/ghost/danger split that
     did read as three inconsistent buttons for one job, that was right.

     What it missed is that the actions are not all one job. `Claim` takes work
     on and `Archive` closes a record, and down a thirteen-row list the button
     is the strongest thing on screen while saying nothing about which it is.
     So: a filled button MOVES THE WORK FORWARD, an outlined one ENDS THE
     RECORD. One rule, readable down the action column, and no third style —
     Claim, Merge Done, Send Items, Submit and Approve Merge all keep the fill
     they have always had. Same 116px track either way; only the paint moves. */
  const quickActionClass = primaryAction
    ? `btn-sm task-card-quick-action${primaryAction.terminal ? " task-card-quick-action-terminal" : ""}`
    : "";

  /* Terminal three-way resolution of the action slot when the ladder above
     produced nothing (#117). An empty slot used to read as a rendering
     failure on your own tasks. In order:

       1. `Waiting on <first name>` — the flow is waiting on someone who
          isn't you (pendingPartyFor, from the shared workflow module).
          Passive label, never a button: the ball is legitimately in someone
          else's court, so offering a destructive action here would be wrong.
          Shown to observers too, not just the creator and assignee (#117
          originally gated it on being a party). It states whose move it is,
          which is the same thing the Assigner/Assignee columns already tell
          an observer, and the slot is otherwise dead space on exactly the
          statuses where the row has the least to say.
       2. Cancel — you created it and it's still cancellable. The creator
          condition and the shared canCancelTask now say the same thing: since
          ADR-0003 stripped the admin branch, cancelling is the creator's move
          and nobody else's, on this row or in the hamburger.
       3. The reserved spacer — observers and anyone else with no standing.

     Mini (closed) rows get none of it; they have no action column. */
  const pendingParty = pendingPartyFor(task);
  const waitingOn = pendingParty === "CREATOR" ? task.createdBy : pendingParty === "ASSIGNEE" ? task.assignee : undefined;
  /* The pull owns the slot when the pull is what put this row in "Needs you".
     `pendingPartyFor` knows the chain and nothing about the message pull, so a
     row lifted here by an unread reply used to sit under the heading "Needs
     you" reading `Waiting on Suzie` — the section and the slot contradicting
     each other in the one place both are scanned, which is the promise the
     whole product is organised around ("the group a task sits in never
     disagrees with the button it offers", PRODUCT.md).

     Two words, because the pull has two states and the row should say which:
     `Unread reply` while the dot is still lit, `Read reply` once the viewer has
     opened it and the court hold is the only thing keeping the row here. Both
     are still passive spans — the ball is genuinely in the other party's court,
     so this reports why the row is in front of you and offers no move. */
  const pulledIntoCourt = hasUnreadNote || courtHeld === true;
  const waitingLabel =
    !primaryAction && waitingOn && waitingOn.id !== user.id
      ? pulledIntoCourt
        ? (hasUnreadNote ? "Unread reply" : "Read reply")
        : `Waiting on ${firstName(waitingOn.displayName)}`
      : null;
  /* `transitions` already carries the status's allowed moves, so CANCELLED
     being in it is the same rule the server enforces. */
  const showRowCancel =
    showActions && !primaryAction && !waitingLabel && isCreator && !isClosed && transitions.includes("CANCELLED");

  /* Expanded body, rendered below the collapsed row when open.
     Mirrors the design's accordion: a slim metadata strip up top, then a
     220px / 1fr split — Timeline + actions on the left, the conversation
     thread on the right. */
  const canPostNote =
    showActions &&
    !CLOSED_STATUSES.includes(task.status) &&
    canNoteTask;

  /* Fire a FRAUD move. Every one of them is one tap now, including the two that
     hand back — the checklist is the payload the server asks for, so there is
     nothing to compose on the way out. A hand-back with an empty checklist never
     reaches here: shared `fraudCardActions` blocks the button first. */
  const runFraudAction = (action: FraudCardAction): void => {
    if (action.blockedReason) return;
    acknowledgeUnread();
    if (action.kind === "release") {
      void onRelease(task.id);
    } else if ((action.kind === "transition" || action.kind === "transitionWithNote") && action.targetStatus) {
      void onTransition(task.id, action.targetStatus);
    }
  };

  const cancelBlock = (
    <>
      {showActions && cancelStage === "confirming" && (
        <div className="task-card-cancel-confirm" role="alertdialog" aria-label="Confirm cancel">
          <span>Cancel this task?</span>
          <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("done"); void onTransition(task.id, "CANCELLED"); }}>
            Yes, cancel
          </button>
          <button type="button" className="btn-sm btn-ghost" onClick={() => setCancelStage("idle")}>
            Keep
          </button>
        </div>
      )}
      {showActions && cancelStage === "done" && (
        <div className="task-card-cancel-confirm task-card-cancel-done" role="status">Cancelled ✓</div>
      )}
    </>
  );

  /* The terminal confirm. Reuses `.task-card-cancel-confirm` wholesale so the
     row has one way of asking a question, and follows its wording rule: the
     answers are answers, not OK and Cancel. The safe answer is second and the
     acting one carries the pressed action's own word, so nobody confirms
     "Yes" without seeing what they are saying yes to. */
  const terminalBlock = showActions && pendingTerminal && (
    <div className="task-card-cancel-confirm task-card-terminal-confirm" role="alertdialog" aria-label={`Confirm ${pendingTerminal.label}`}>
      <span>{pendingTerminal.label} this task?</span>
      <button
        type="button"
        className="btn-sm"
        onClick={() => { const act = pendingTerminal; setPendingTerminal(null); setMenuOpen(false); act.run(); }}
      >
        {`Yes, ${pendingTerminal.label.toLowerCase()}`}
      </button>
      <button type="button" className="btn-sm btn-ghost" onClick={() => setPendingTerminal(null)}>
        Keep open
      </button>
    </div>
  );

  /* The alternatives to the phase's forward move (#39) — `Send Back`'s bounce
     and `Release`'s hand-off to the checker pool. Both are steps sideways or
     backwards, so they live in the menu next to `Send back to checker` and
     `Undo Merge Done` rather than in the body. Same set the bot DM cards
     render, minus the note path the bot still has and this app no longer does.

     A hand-back with an empty checklist is offered and disabled rather than
     opening a composer — `blockedReason` from shared `fraudCardActions`, the
     same treatment `Submit` gets and the same sentence the server's refusal
     would carry. The explanation rides `title` and `aria-label` so a disabled
     control keeps it on the assistive path. */
  const fraudMenuActions = expandedFraudActions.map((action) => (
    <div key={action.label} className="task-card-fraud-action">
      <button
        type="button"
        className="btn-sm btn-ghost"
        disabled={Boolean(action.blockedReason)}
        title={action.blockedReason}
        aria-label={action.blockedReason ? `${action.label} — ${action.blockedReason}` : undefined}
        onClick={() => runFraudAction(action)}
      >
        {action.label}
      </button>
    </div>
  ));

  /* Everything else — the actions-menu ladder, rendered inside the
     hamburger (see actionsMenu below), not in the expanded body. */
  const secondaryActionsBlock = showActions && cancelStage === "idle" && (
    <>
      {fraudMenuActions}
      {task.status === "OPEN" && isCreator && (
        <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
          Cancel Task
        </button>
      )}
      {canUnclaimTask(task, user) && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onUnclaim(task.id); }}>
          Unclaim
        </button>
      )}
      {/* #208: the creator takes their own request off a holder who has stalled
          and puts it back where anyone can claim it. This is the replacement for
          handing yourself somebody else's task, which is no longer allowed — the
          move belongs to the person who asked for the work, and it happens in
          the open rather than by quietly reassigning the task to yourself.
          `canReturnToPool` is the shared predicate the server enforces, and it
          stands down for a Fraud Check at PENDING_APPROVAL, where `Release for
          any fraud checker` is the same move under its own name. */}
      {canReturnToPool(task, user) && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onReturnToPool(task.id); }}>
          {ACTION_LABELS.RETURN_TO_POOL}
        </button>
      )}
      {task.status === "CLAIMED" && isCreator && !isAssignee && (
        <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
          Cancel
        </button>
      )}
      {/* `Send back to checker` used to live here (#125, renamed #237). It has
          moved to the row, as the second exit of the creator's `Fixed` panel —
          it is one of their two moves out of corrections, not a rare backwards
          step, and leaving it in the menu while `Complete` sat on the row made
          one easy and the other a hunt. That asymmetry is the thing #172 was
          filed about; the fallback below still renders it here whenever the
          panel is not shown, so no seat loses the move.

          It is deliberately NOT grouped with `Undo Merge Done` any more: that
          one really is an undo, and this one is a creator asking for a
          confirming second look. */}
      {task.status === "NEEDS_REVIEW" && !showFixedPanel && canTransitionStatus(task, "CLAIMED", user).ok && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CLAIMED"); }}>
          {ACTION_LABELS.SEND_BACK_TO_CHECKER}
        </button>
      )}
      {task.status === "MERGE_DONE" && isAssignee && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CLAIMED"); }}>
          Undo Merge Done
        </button>
      )}
      {task.status === "MERGE_DONE" && (isCreator || isAssignee) && (
        <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
          Cancel
        </button>
      )}
      {task.status === "MERGE_APPROVED" && (isCreator || isAssignee) && (
        <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
          Cancel
        </button>
      )}
      {task.status === "COMPLETED" && isCreator && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "ARCHIVED"); }}>
          {ACTION_LABELS.ARCHIVE}
        </button>
      )}
      {(task.status === "COMPLETED" || task.status === "ARCHIVED") && (isCreator || isAssignee) && (
        <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "OPEN"); }}>
          Re-open
        </button>
      )}
      {/* Add a note to a COMPLETED task (#45): reveal an inline field
          that posts to the completed-note endpoint (task stays
          COMPLETED). Every task type; creator/assignee/admin. */}
      {task.status === "COMPLETED" && canNoteTask && (
        <button
          type="button"
          className="btn-sm btn-ghost"
          aria-expanded={completedNoteOpen}
          onClick={() => { acknowledgeUnread(); setCompletedNote(""); setCompletedNoteOpen((open) => !open); }}
        >
          Add a note
        </button>
      )}
      {/* A reopened task remembers the closed status it came from.
          "Restore" sends it straight back there (COMPLETED or ARCHIVED),
          available to whoever reopened it — creator or assignee —
          so a creator-only reopen doesn't need the assignee to close it
          out. Gated by the shared canRestoreTask so UI and API agree. */}
      {restoreTarget && canRestoreTask(task, user) && (
        <button type="button" className="btn-sm btn-good" onClick={() => { acknowledgeUnread(); onTransition(task.id, restoreTarget); }}>
          Restore
        </button>
      )}
      {/* Inline note field for the "Add a note" affordance (#45). Full
          width below the action buttons; Enter (no shift) or Add posts,
          Esc / Cancel dismisses. */}
      {task.status === "COMPLETED" && completedNoteOpen && (
        <div className="task-card-note-add">
          <textarea
            rows={2}
            placeholder="Add a note to this completed task…"
            value={completedNote}
            onChange={(e) => setCompletedNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitCompletedNote(); }
              if (e.key === "Escape") { setCompletedNoteOpen(false); setCompletedNote(""); }
            }}
            autoFocus
          />
          <div className="task-card-note-add-actions">
            <button type="button" className="btn-sm btn-good" onClick={() => void submitCompletedNote()} disabled={!completedNote.trim()}>
              Add note
            </button>
            <button type="button" className="btn-sm btn-ghost" onClick={() => { setCompletedNoteOpen(false); setCompletedNote(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );

  /* Share (issues #41, #52, #58): a menu row now, not a standalone icon
     trigger — DM a specific person a deep link to this task, outside the
     normal creator/assignee flow. Hidden when there's nobody else in the
     directory to point at. */
  const shareMenuItemBlock = shareCandidates.length > 0 && (
    <SharePopover
      candidates={shareCandidates}
      onShare={(targetUserId, note) => onShare(task.id, targetUserId, note)}
      link={shareLink}
      webLink={webShareLink}
      asMenuItem
    />
  );

  /* `Edit Task` (#260, ADR-0008 rule 4) — the one door onto what the task
     says. It opens the form the task was filed with, preloaded and saving
     instead of creating; the old `Edit request` button that sat inside the
     expanded body is gone.

     Gated on the shared predicate the server's own refusal is written from, so
     a row can't offer an edit the server would turn away. Since #263 that is
     the creator on any type, plus the checker holding an LOI — its terms are
     facts they are verifying, and they are the person who spots a wrong one
     (ADR-0008 rule 5). Never an observer, an unclaimed file checker or an
     admin. A closed task is a record rather than an ask, and re-opening is the
     route to a genuine late correction (ADR-0008 rule 6).

     The form behind the door carries the request field alone today, which is
     exactly the field this predicate asks about. Urgency and poop points join
     it in #261 and stay the creator's, so that ticket gates them individually
     rather than widening this.

     First in the panel, above the status ladder. It is not a move through the
     workflow — it changes what the task says, not where it is — and the thing
     someone opens this menu to fix is usually the thing they just noticed is
     wrong. */
  const editMenuItemBlock = canAmendTask(task, user) && (
    <button
      type="button"
      className="btn-sm btn-ghost"
      onClick={() => { closeMenu(); onEditTask(task.id); }}
    >
      Edit Task
    </button>
  );

  /* Handoff (ADR-0002): a menu row of its own, next to Share but never merged
     with it — share tells someone about a task, this moves it into their court.
     Reads "Assign" while nobody holds it and "Reassign" once someone does.
     Visible to everyone (anyone may hand a task off) and hidden entirely on a
     closed task, where `canAssignTaskTo` also empties the candidate list. */
  const assignMenuItemBlock = !isClosed && assignCandidates.length > 0 && (
    <AssignPopover
      label={task.assignee ? ACTION_LABELS.REASSIGN : ACTION_LABELS.ASSIGN}
      candidates={assignCandidates}
      onAssign={(assigneeUserId, note) => onAssign(task.id, assigneeUserId, note)}
    />
  );

  /* Actions menu: hamburger next to the row's primary action (see the
     collapsed row below), holding Share plus the secondary ladder
     (Re-open, Add a note, Unclaim, Cancel, Archive, Restore, Undo Merge
     Done, Send back to checker, and FRAUD's Send Back / Release), and closing on the
     card's timestamps as a non-interactive footnote (#166). Cancel's
     confirm/done UI renders inside the same
     panel so it stays visible once triggered, matching the in-place-swap
     behavior it always had. stopBubble on the wrapping span keeps clicks in this
     subtree from also toggling the collapsed row's expand/collapse. The panel is
     portaled to the body (#122) but still renders inside that span in the React
     tree, and React events propagate through the React tree rather than the DOM
     one, so the span still covers it — the panel repeats stopBubble anyway,
     because relying on a DOM-detached ancestor for that is exactly the kind of
     thing a later refactor breaks silently. */
  /* Created, the task's other timestamp, and — for a task someone is holding —
     when that person took it on, at the foot of the panel below a
     hairline — the way a context menu carries "Last modified" (#166). Reference
     detail, not a move anyone makes, so it reads as plain text: no pointer, no
     tab stop, nothing to arrow onto between the actions and the end of the menu.
     It used to be a full row plus its rule at the bottom of every expanded card.

     `role="group"` rather than `role="none"`: `group` is an owned role of
     `menu`, so the block stays a labelled, announced part of the panel — with
     `none` a screen reader in menu mode walks past it and the information is
     simply absent. It is still not a `menuitem`, so it is neither focusable nor
     an arrow-key stop. The dates are `<time>` so the machine-readable instant
     travels with the localised string a person reads. */
  const menuTimestamps = (
    <div className="task-card-menu-times" role="group" aria-label="Timestamps">
      <span><b>Created</b> <time dateTime={task.createdAt}>{formatDate(task.createdAt)}</time></span>
      {timeMeta && <span><b>{timeMeta.label}</b> <time dateTime={timeMeta.iso}>{timeMeta.value}</time></span>}
      {claimedAt && <span><b>Claimed</b> <time dateTime={claimedAt}>{formatDate(claimedAt)}</time></span>}
      {/* Who closed it (#239). A creator may close a task assigned to somebody
          else, so "Completed" on its own would read as the assignee's sign-off —
          and that is the one question a task history gets asked weeks later. */}
      {completer && <span><b>Completed by</b> {completer.displayName}</span>}
      {archiver && <span><b>Archived by</b> {archiver.displayName}</span>}
    </div>
  );

  /* How Bad?, on a task whose one copy lives in the menu (#335): dropped and
     re-offered, claimed, in flight or closed. Read-only for everyone — the
     rating changes in the task form alone. Reference detail like the
     timestamps under it, and wrapped the same way: a labelled `group`,
     announced as part of the panel without becoming an arrow-key stop. Null
     for an unrated task, so `menuHasContent` reads it like any other block. */
  const menuRating = ratingBlock("menu", task);

  /* Whether the menu has anything worth opening. Written as "is any block
     non-empty" rather than a list of action checks, because the answer stopped
     being about actions when the timestamps moved in: a closed task and a task
     you have no seat on both have no actions at all, and they are the rows
     someone is most likely to open the menu on to check a date. Created always
     renders, so in practice the trigger is now on every row — this stays a
     computed answer rather than `true` so it follows the contents if a later
     change makes the block conditional. */
  const menuHasContent = [
    editMenuItemBlock,
    secondaryActionsBlock,
    shareMenuItemBlock,
    assignMenuItemBlock,
    cancelStage !== "idle",
    menuRating,
    menuTimestamps
  ].some(Boolean);
  const actionsMenu = menuHasContent && (
    <span onClick={stopBubble} className="task-card-menu">
      <button
        type="button"
        ref={menuTriggerRef}
        className="task-card-menu-trigger"
        /* Not "More actions": since #166 the panel opens on rows that have
           none — a closed task, a task you hold no seat on — carrying nothing
           but the timestamp block. Naming the container rather than its
           contents is true on every row, and keeps the label out of the
           business of reasoning about which actions exist, which is the same
           trap `menuHasContent` below was written to avoid. */
        aria-label="Task menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => { e.stopPropagation(); if (menuOpen) closeMenu(); else setMenuOpen(true); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuPanelRef}
          className="task-card-menu-panel"
          role="menu"
          onClick={stopBubble}
          style={menuPanelStyle}
        >
          {cancelBlock}
          {terminalBlock}
          {cancelStage === "idle" && !pendingTerminal && editMenuItemBlock}
          {!pendingTerminal && secondaryActionsBlock}
          {!pendingTerminal && shareMenuItemBlock}
          {!pendingTerminal && assignMenuItemBlock}
          {!pendingTerminal && menuRating}
          {!pendingTerminal && menuTimestamps}
        </div>,
        document.body
      )}
    </span>
  );

  const checklistBlock = task.taskType === "FRAUD" && <FraudChecklist task={task} user={user} api={checklist} />;

  /* Where the task's own field is drawn, and where it isn't (ADR-0010 rule 1,
     widening ADR-0008 rules 1 and 2). `standingInstructionsFor` decides once:
     on the five box types it hands back the instructions, the
     `InstructionsSection` above the thread draws them, and `ThreadMessages`
     leaves the conversation to the replies. On a Fraud Check it hands back
     nothing, the section renders nothing, and the field opens the thread as
     before — its standing ask is the outstanding-items list further up this
     same body, so a prose box above it would say the same thing twice.

     The box is held to edit since #303 (ADR-0010 rule 4) — the second door onto
     the field, beside the hamburger's `Edit Task`, which keeps it. Whether the
     box answers a hold at all is the shared `canAmendTask`, asked inside the
     section; nothing about who may correct what is decided here. */
  const fieldIsInThread = standingInstructionsFor(task) === undefined;
  const instructionsBlock = fieldIsInThread ? null : (
    <div className="task-card-terms">
      <InstructionsSection task={task} viewerId={user.id} onSave={saveInstructions} />
    </div>
  );
  const notesBlock = (
    <>
      <div className="thread-head">{THREAD_HEAD_LABEL}</div>
      <div className="msgs" ref={reviewListRef}>
        <ThreadMessages
          task={task}
          viewerId={user.id}
          canReply={canPostNote}
          onEditMessage={editMessage}
          onDeleteMessage={deleteMessage}
        />
      </div>
      {canPostNote && (
        <div className="composer">
          <textarea
            rows={1}
            placeholder="Add a note…"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSubmitNote(); } }}
          />
          <button type="button" className="btn-sm" onClick={() => void handleSubmitNote()} disabled={!noteText.trim()}>Send</button>
        </div>
      )}
    </>
  );

  /* Expanded body: always a single stacked column, sections separated by a
     hairline rather than nested card chrome. Leads with the status timeline
     (compact horizontal rail) so opening a card says where it sits in its
     flow, then FRAUD forward moves → checklist → terms → notes, ending on the
     thread.
     No due-pill — the collapsed row's own OVERDUE/due chip already shows that.
     Secondary actions never show here — they live in the row's hamburger, and
     since #166 so do the Created/Due timestamps that used to close the body
     out.

     The terms section (LOI only, ADR-0008) sits directly above the thread: it
     is what the conversation below it is about, so it reads in that order, and
     it is the last thing before the replies rather than the first thing in the
     body — the timeline still answers "where is this" first. */
  /* One menu open at a time across the whole body, counting the box's and the
     thread's alike (#303). The provider is what makes that one variable rather
     than two — see `CardMenuScopeProvider` in `thread.tsx`. Per card, so two
     expanded cards do not close each other's menus. */
  const renderExpanded = () => (
    <CardMenuScopeProvider>
      <div className="task-card-expanded">
        <Timeline task={task} />
        {/* No How Bad? here, in any state (#335): the row carries it on a
            task out for the first time, the hamburger on every other, and the
            row does not unmount on expand, so a copy here was the same number
            twice. */}
        {checklistBlock && <div className="task-card-checklist">{checklistBlock}</div>}
        {instructionsBlock}
        <div className="thread">{notesBlock}</div>
      </div>
    </CardMenuScopeProvider>
  );

  /* Grouped-row people values: Assignee = assignee (or "Unclaimed"), Assigner =
     creator. Shown as avatar chip + first name. The viewer's own name renders
     bold in whichever slot it appears (#93) — pure "is this name mine", not
     conditional on which role the viewer is looking from. */
  const ownerName = task.assignee?.displayName;
  const due = groupedDue(task, now ?? Date.now(), isCreator);
  const groupedOverdue = due.overdue;

  return (
    <div className={cardClass} id={`task-${task.id}`}>
      <div
        className={`task-card-grouped${mini ? " task-card-grouped-mini" : ""}${groupedOverdue ? " task-card-grouped-overdue" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKey}
        title={urgencyTitle}
      >
        {/* Assigner→assignee, one line: avatar pill + arrow, not two
            stacked "ASSIGNEE"/"ASSIGNER" label rows. Names never
            truncate — the title's own minmax(0,1fr) column is the one
            that gives via ellipsis, same as it already does elsewhere
            in this row. */}
        <span className="task-card-pair">
          <span className="task-card-pair-person">
            <span className="task-card-pair-avatar" style={avatarStyle(task.createdBy.id)} aria-hidden="true">{initialsOf(task.createdBy.displayName)}</span>
            <span className={`task-card-pair-name${isCreator ? " task-card-pair-name-mine" : ""}`} title={task.createdBy.displayName}>{firstName(task.createdBy.displayName)}</span>
          </span>
          <span className="task-card-pair-arrow" aria-hidden="true">→</span>
          <span className="task-card-pair-person">
            {task.assignee ? (
              <>
                <span className="task-card-pair-avatar" style={avatarStyle(task.assignee.id)} aria-hidden="true">{initialsOf(ownerName)}</span>
                <span className={`task-card-pair-name${isAssignee ? " task-card-pair-name-mine" : ""}`} title={ownerName}>{firstName(ownerName)}</span>
              </>
            ) : (
              <>
                <span className="task-card-pair-avatar task-card-pair-avatar-none" aria-hidden="true" />
                <span className="task-card-pair-name task-card-pair-name-none">Unclaimed</span>
              </>
            )}
          </span>
        </span>
        <span className="task-card-collapsed-title">
          {/* Loan name first and dominant — it is what a person scans for. The
              type sits beside it, right of a hairline, in ink rather than a
              whisper: trailing a name of variable width it landed at a
              different x on every row and was simply not being found. The ↗ is
              gone (a unicode arrow standing in for an icon, and a colour emoji
              on mobile); the name is still the link and says so with the same
              standing underline every link carries now. The per-row loan filter
              is gone. */}
          <span className="task-card-collapsed-folder">
            {task.taskType !== "OOO" && task.humperdinkLink ? (
              <a href={task.humperdinkLink} target="_blank" rel="noreferrer" aria-label={`Open Humperdink link for ${task.folderName}`} title="Open Humperdink link" onClick={stopBubble}>
                <span className="task-card-collapsed-folder-name">{task.folderName}</span>
              </a>
            ) : (
              <span className="task-card-collapsed-folder-name">{task.folderName}</span>
            )}
          </span>
          {/* Three children, and which of them may be cut is the whole point.
              The dot never is: it used to be a plain child alongside the text,
              so the ellipsis capping the type ate it too, and on a phone a
              fraud check at final approval lost the one signal saying a note is
              waiting, on the surface with no zoom to go looking with.

              The stage is its own box rather than words inside the type's, so
              it is the part that gives — the type names what the task IS and
              stays whole, and a cut lands on the stage behind it. On a phone
              (2026-09-07) it stops being cut at all and takes a line of its
              own under the type: `Fraud Check - Final Approval Needed` wants
              ~290px against a title cell of about 200px there, so what a person
              actually read was `FRAUD CHECK - FINAL APP…`. The hyphen is the
              join for the one-line arrangement and goes with it. */}
          <span className={`task-card-collapsed-type task-type-${task.taskType.toLowerCase()}`}>
            <span className="task-card-collapsed-type-text">{TASK_TYPE_LABELS[task.taskType]}</span>
            {stageSuffix(task) && (
              <span className="task-card-collapsed-stage">
                <span className="task-card-collapsed-stage-join" aria-hidden="true">&nbsp;-&nbsp;</span>
                {stageSuffix(task)}
              </span>
            )}
            {hasUnreadNote && (
              <span className="task-card-unread-dot" aria-label="New note" title="New note" />
            )}
            {/* How Bad?, and it shares the stage's line rather than holding one of
              its own (2026-09-10). The two can never both appear, which is what
              lets one reserved line serve both and takes a whole line back off
              every card: a stage only exists on a LOAN_DOCS mid-merge or a FRAUD
              mid-exchange, both of which have been claimed, and the rating only
              appears on a task that is unclaimed AND has never been dropped. A
              released check has a stage and no rating; a task fresh in the pool
              has a rating and no stage. If that ever stops being true they share
              the line side by side and it wraps — nothing breaks, the card just
              grows, which is the honest failure.

              It sits above the names rather than beside them (the user's call):
              on a phone the title block is a column, so this lands under the
              type and over the pair.

              Only while the task is up for grabs (2026-09-07). The score answers
              one question, "can I take a five-poop set of loan docs right now",
              and that is only live for somebody looking at work nobody holds.
              #329 took it off the row entirely because five emoji rode every row
              in the list including the ~117 closed ones — the same fact stated
              wrongly rather than a fact worth hiding. Read-only here: a
              five-slot editable track in a row that is itself a press target is
              five touch targets nobody asked for, and the creator rates it in
              the expanded body or on the edit form.

              **An OOO is included, and it is the case this is most for.** A
              review pass excluded it on the reasoning that a vacation notice is
              never picked up; that is wrong, and the app says so in four places.
              `canClaimTask` opens for it like any other OPEN task, the board
              files it under *Up for grabs* with a `Claim` button, its channel
              card reads "will be out of the office … and needs coverage. Can you
              help?", and `TASK_NEEDS_PHRASE` calls it "needs OOO Coverage".
              Somebody covering an absence is deciding exactly the thing the
              score exists to answer — a quiet week and a heavy pipeline are not
              the same ask. The two shared rules that DO exclude an OOO,
              `isPoolNagEligible` and `isUnclaimedTooLong`, are about nagging
              cadence and not about pickup; don't borrow them for a question
              about the pool.

              **A task dropped and re-offered does not get one** (2026-09-10).
              The score is the ask as its filer sized it and describes a whole
              job; a check somebody has already been half way through is not that
              job any more. Shared `isFirstTimeInPool` is the test — it compares
              when the task reached the pool against when it was filed, which is
              true under both spellings of never-left, the field absent or
              stamped equal to `createdAt` the way the dev seed writes it. A bare
              `!task.pooledSince` reads as "this has been dropped" on every seeded
              open task on the board. */}
            {ratingBlock("row", task)}
          </span>
        </span>
        <span className={`task-card-grouped-due${groupedOverdue ? " task-card-grouped-due-overdue" : ""}${due.done ? " task-card-grouped-due-done" : ""}`} title={dueTitle}>
          {due.label && <span className="task-card-grouped-due-label">{due.label}</span>}
          <span className="task-card-grouped-due-value">{due.value}</span>
        </span>
        <span className="task-card-action-cell">
          {actionsMenu}
          {/* Mini (closed) rows never have a primary action — skip the
              spacer entirely instead of reserving its 116px, which used to
              strand empty space between the outcome stamp and the menu. */}
          {!mini && (showCheckedPanel ? (
            /* #231: the LOI checker's two exits, in the slot the plain
               Complete used to hold. First in the chain because on this cell it
               IS the ladder's Complete branch — that branch stands down for it
               above, so the two can never both render. */
            <TwoExitPanel
              triggerLabel={ACTION_LABELS.CHECKED}
              dialogLabel="How did the check go?"
              onBeforeAction={acknowledgeUnread}
              exits={[
                { label: ACTION_LABELS.GOOD_TO_GO, run: () => { void onTransition(task.id, "COMPLETED"); } },
                {
                  label: ACTION_LABELS.NEEDS_FIXES,
                  ghost: true,
                  note: {
                    prompt: "What needs fixed?",
                    /* The placeholder carries the requirement: the empty box is
                       where the person is looking, so that is where it has to
                       say a note is not optional. */
                    placeholder: "A note is required",
                    blockedReason: NEEDS_FIXES_NOTE_REQUIRED
                  },
                  run: (note) => { void onTransition(task.id, "NEEDS_REVIEW", note); }
                }
              ]}
            />
          ) : showFixedPanel ? (
            /* The creator's side of the same loop. `Complete` leads: ADR-0007
               rule 2 makes it the common case, since the correction is usually
               a typo in their own text and needs no second opinion. The
               send-back is the second exit, out of the hamburger where it used
               to hide. */
            <TwoExitPanel
              triggerLabel={ACTION_LABELS.FIXED}
              dialogLabel="You have made the corrections — what now?"
              onBeforeAction={acknowledgeUnread}
              exits={[
                { label: ACTION_LABELS.NO_REVIEW_NEEDED, run: () => { void onTransition(task.id, "COMPLETED"); } },
                { label: ACTION_LABELS.SEND_BACK_TO_CHECKER, ghost: true, run: () => { void onTransition(task.id, "CLAIMED"); } }
              ]}
            />
          ) : primaryAction ? (
            /* A blocked action keeps its slot rather than vanishing: the
               requester needs to see that Submit is the next step and why it
               won't go. The title rides the wrapper because a disabled button
               doesn't raise the hover events a tooltip needs. */
            <span
              className="task-card-quick-action-slot"
              title={primaryAction.blockedReason}
              onClick={(e) => { if (primaryAction!.blockedReason) { e.stopPropagation(); setExpanded(true); } }}
            >
              <button
                type="button"
                className={quickActionClass}
                disabled={Boolean(primaryAction.blockedReason)}
                aria-label={primaryAction.blockedReason ? `${primaryAction.label} — ${primaryAction.blockedReason}` : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  acknowledgeUnread();
                  /* A terminal press asks first, in the menu panel, exactly the
                     way the row's Cancel already does — one confirm component
                     for the row, not a second one. Everything else fires. */
                  if (primaryAction!.terminal) {
                    setPendingTerminal({ label: primaryAction!.label, run: primaryAction!.run });
                    setMenuOpen(true);
                  } else {
                    primaryAction!.run();
                  }
                }}
              >
                {primaryAction.label}
              </button>
            </span>
          ) : waitingLabel ? (
            /* Passive indicator, not a control — no button, no handler. */
            <span className="task-card-quick-action-waiting" title={waitingLabel}>{waitingLabel}</span>
          ) : showRowCancel ? (
            /* Reuses the hamburger's two-step confirm verbatim: drive its
               stage to `confirming` and open the panel so the existing
               "Cancel this task?" row (and its "Cancelled ✓" flash) appears
               in place. No second confirm component. */
            <button
              type="button"
              className="btn-sm btn-danger task-card-quick-action task-card-quick-action-cancel"
              onClick={(e) => { e.stopPropagation(); acknowledgeUnread(); setCancelStage("confirming"); setMenuOpen(true); }}
            >
              {ACTION_LABELS.CANCEL}
            </button>
          ) : (
            <span className="task-card-quick-action-empty" aria-hidden="true" />
          ))}
        </span>
      </div>
      {expanded && renderExpanded()}
    </div>
  );
});
TaskCard.displayName = "TaskCard";

/* ── Card List ────────────────────────────────────────────── */
const CardList = ({
  tasks,
  user,
  onClaim,
  onUnclaim,
  onReturnToPool,
  onTransition,
  onRelease,
  onAddReviewNote,
  onEditMessage,
  onDeleteMessage,
  onSaveInstructions,
  onAddCompletedNote,
  onEditTask,
  taskHistory,
  onShare,
  onAssign,
  checklist,
  directory,
  teamsAppId,
  showActions,
  emptyMessage,
  seenNotesAt,
  onMarkNoteSeen,
  pulsingIds,
  expandOverrides,
  courtHolds,
  onSetExpand,
  now
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onReturnToPool: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onRelease: (taskId: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  /* Correct a message you posted (#287, ADR-0009). Addressed by the message's
     own identifier, not its position: the thread hands back what it was given,
     and the server is the one that decides whether the author may. */
  onEditMessage: (taskId: string, messageId: string, text: string) => Promise<void>;
  /* Withdraw a message you posted (#288, ADR-0009 rule 4). One way and no
     payload: the thread hands back the identifier it was given, and the server
     decides whether the author may. */
  onDeleteMessage: (taskId: string, messageId: string) => Promise<void>;
  /* Save the Instructions box from the box itself (#303, ADR-0010 rule 4). The
     same route the edit form's save reaches, so the two doors onto this one
     field cannot produce different results. */
  onSaveInstructions: (taskId: string, text: string) => Promise<void>;
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  /* Open the edit form on this task (#260). App owns the form and the save, so
     the row hands over an id and nothing else — a card that held the draft
     would lose it on every list refresh. */
  onEditTask: (taskId: string) => void;
  taskHistory: TaskHistoryApi;
  onShare: (taskId: string, targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  onAssign: (taskId: string, assigneeUserId: string, note?: string) => Promise<void>;
  checklist: ChecklistApi;
  directory: DirectoryUser[];
  teamsAppId: string | null;
  showActions: boolean;
  emptyMessage: string;
  seenNotesAt?: Record<string, string>;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsingIds?: Set<string>;
  expandOverrides?: Record<string, boolean>;
  courtHolds?: CourtHolds;
  onSetExpand?: (taskId: string, open: boolean, pulled?: boolean) => void;
  now?: number;
}) => (
  <div className="card-list card-list-grouped">
    {tasks.length === 0 ? (
      <div className="empty-card">{emptyMessage}</div>
    ) : (
      /* Only live-countdown (non-closed) rows take the ticking `now` (#73):
         `groupedDue` ignores it for COMPLETED / CANCELLED / ARCHIVED, so
         withholding it keeps those cards' props stable and lets TaskCard's memo
         skip them on a 30s tick. Active cards still re-render on a tick — their
         countdown is the input that changed. */
      tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          user={user}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          onReturnToPool={onReturnToPool}
          onTransition={onTransition}
          onRelease={onRelease}
          onAddReviewNote={onAddReviewNote}
          onEditMessage={onEditMessage}
          onDeleteMessage={onDeleteMessage}
          onSaveInstructions={onSaveInstructions}
          onAddCompletedNote={onAddCompletedNote}
          onEditTask={onEditTask}
          taskHistory={taskHistory}
          onShare={onShare}
          onAssign={onAssign}
          checklist={checklist}
          directory={directory}
          teamsAppId={teamsAppId}
          showActions={showActions}
          pulsing={pulsingIds?.has(task.id) ?? false}
          {...(now !== undefined && !CLOSED_STATUSES.includes(task.status) ? { now } : {})}
          {...(seenNotesAt?.[task.id] !== undefined ? { seenNoteAt: seenNotesAt[task.id] } : {})}
          {...(onMarkNoteSeen ? { onMarkNoteSeen } : {})}
          {...(expandOverrides?.[task.id] !== undefined ? { expandOverride: expandOverrides[task.id] } : {})}
          courtHeld={isCourtHeld(courtHolds ?? {}, task.id)}
          {...(onSetExpand ? { onSetExpand } : {})}
        />
      ))
    )}
  </div>
);

/* ── App menu ─────────────────────────────────────────────── */
/* The settings that are not decisions about a task. Grouped/Flat and Collapse
   all used to sit on every list header, next to New Task, which put three
   controls of very different frequency on one line: New Task is pressed all
   day, the other two are pressed once and then left alone for hours. They are
   preferences wearing the clothes of actions, so they moved in here and New
   Task kept the header to itself.

   Theme joined them because it is the same kind of thing, and because until now
   there was nowhere in the app to change it at all. */
const AppMenu = ({
  grouped,
  onGroupedChange,
  history,
  onHistoryChange,
  expandedIds,
  onCollapseAll,
  themeChoice,
  onThemeChange
}: {
  grouped: boolean;
  onGroupedChange: (next: boolean) => void;
  /* How far back finished tasks go (#391). Everyone / Mine used to sit above
     it as the Show row; since #390 that choice is the board's All Tasks and My
     Tasks tabs. */
  history: BoardHistory;
  onHistoryChange: (next: BoardHistory) => void;
  expandedIds: string[];
  onCollapseAll: (taskIds: string[]) => void;
  themeChoice: ThemeChoice;
  onThemeChange: (next: ThemeChoice) => void;
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* Closes on an outside press and on Escape, the same two exits every other
     transient surface in this app answers to. */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: globalThis.MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const collapseCount = expandedIds.length;

  return (
    <div className="app-menu" ref={wrapRef}>
      <button
        type="button"
        className="app-menu-trigger"
        aria-label="App settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SettingsIcon />
      </button>
      {open && (
        <div className="app-menu-panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="app-menu-action"
            aria-disabled={collapseCount === 0}
            onClick={() => {
              if (collapseCount === 0) return;
              onCollapseAll(expandedIds);
              setOpen(false);
            }}
          >
            Collapse all
            {collapseCount > 0 && <span className="app-menu-action-count">{collapseCount}</span>}
          </button>

          <div className="app-menu-group" role="group" aria-label="List view">
            <span className="app-menu-label">View</span>
            <div className="app-menu-choices">
              {[
                { value: true, label: "Grouped" },
                { value: false, label: "Flat" }
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={grouped === opt.value}
                  className={`app-menu-choice${grouped === opt.value ? " app-menu-choice-on" : ""}`}
                  onClick={() => onGroupedChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="app-menu-group" role="group" aria-label="Appearance">
            <span className="app-menu-label">Appearance</span>
            <div className="app-menu-choices">
              {THEME_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitemradio"
                  aria-checked={themeChoice === choice}
                  aria-label={THEME_LABELS[choice].full}
                  className={`app-menu-choice${themeChoice === choice ? " app-menu-choice-on" : ""}`}
                  onClick={() => onThemeChange(choice)}
                >
                  {THEME_LABELS[choice].short}
                </button>
              ))}
            </div>
          </div>

          <div className="app-menu-group" role="group" aria-label="How far back finished tasks go">
            <span className="app-menu-label">History</span>
            <div className="app-menu-choices">
              {BOARD_HISTORY_CHOICES.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={history === opt.value}
                  className={`app-menu-choice${history === opt.value ? " app-menu-choice-on" : ""}`}
                  onClick={() => onHistoryChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


/* New Task, the primary action, sits directly right of the Grouped/Flat
   segment on whichever list header is showing — not in the top app bar,
   which now only holds nav + the dev user picker. */
const NewTaskButton = ({ open, onClick }: { open: boolean; onClick: () => void }) => (
  <button type="button" className="form-toggle" aria-expanded={open} onClick={onClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
    New Task
  </button>
);


/* Every type draws the same bar, and the bar is ink.

   It used to spend the four signal roles as a categorical palette — Fraud on
   `--bad`, Value on `--good`, Loan Docs on `--hot`, and the other three left
   uncoloured, which is a legend with three blanks in it. The signal tokens name
   what a colour MEANS, not what it looks like: painting the Fraud Check row red
   tells an admin that fraud checks are failing, and painting Value green tells
   them value checks are going well, on a chart that is only counting how many
   of each got filed. Three of six rows made that claim and three made none.

   A bar chart differentiates by LENGTH. That is the whole job, the lengths are
   already there, and the labels beside them say which row is which. */
const TYPE_BAR_CLASS: Record<TaskType, string> = {
  LOI: "type-bar",
  BUDDY_CHAT: "type-bar",
  VALUE: "type-bar",
  FRAUD: "type-bar",
  LOAN_DOCS: "type-bar",
  OOO: "type-bar"
};

const MetricsPanel = ({
  leaderboard,
  totals,
  typeBreakdown
}: {
  leaderboard: { id: string; displayName: string; count: number }[];
  totals: { total: number; active: number; completed: number; archived: number; cancelled: number };
  typeBreakdown: { type: TaskType; label: string; count: number; pct: number }[];
}) => {
  const maxClaims = leaderboard[0]?.count ?? 1;
  const maxTypeCount = Math.max(...typeBreakdown.map((t) => t.count), 1);

  return (
    <div className="metrics-panel">
      {/* Claims leaderboard */}
      <div className="metrics-section">
        <div className="metrics-section-title">Who Is Claiming Tasks</div>
        {leaderboard.length === 0 ? (
          <div className="empty-card">No tasks have been claimed yet.</div>
        ) : (
          leaderboard.map((entry, i) => (
            <div key={entry.id} className="leaderboard-row">
              <span className="leaderboard-rank">{i + 1}.</span>
              <span className="leaderboard-name">{entry.displayName}</span>
              <div className="leaderboard-bar-wrap">
                <div className="leaderboard-bar" style={{ width: `${(entry.count / maxClaims) * 100}%` }} />
              </div>
              <span className="leaderboard-count">{entry.count}</span>
            </div>
          ))
        )}
      </div>

      {/* Status totals */}
      <div className="metrics-section">
        <div className="metrics-section-title">Task Overview</div>
        <div className="metrics-stat-grid">
          <div className="stat-card">
            <div className="stat-number">{totals.total}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{totals.active}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{totals.completed}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{totals.archived}</div>
            <div className="stat-label">Archived</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{totals.cancelled}</div>
            <div className="stat-label">Cancelled</div>
          </div>
        </div>
      </div>

      {/* LOI to Docs ratio */}
      {(() => {
        const loiCount = typeBreakdown.find((t) => t.type === "LOI")?.count ?? 0;
        const docsCount = typeBreakdown.find((t) => t.type === "LOAN_DOCS")?.count ?? 0;
        const ratio = loiCount > 0 ? ((docsCount / loiCount) * 100).toFixed(0) : "—";
        return (
          <div className="metrics-section">
            <div className="metrics-section-title">LOI to Docs Conversion</div>
            <div className="loi-docs-ratio">
              <div className="ratio-visual">
                <div className="ratio-segment ratio-segment-loi">
                  <div className="ratio-segment-count">{loiCount}</div>
                  <div className="ratio-segment-label">LOI Checks</div>
                </div>
                <div className="ratio-arrow">→</div>
                <div className="ratio-segment ratio-segment-docs">
                  <div className="ratio-segment-count">{docsCount}</div>
                  <div className="ratio-segment-label">Loan Docs</div>
                </div>
                <div className="ratio-result">
                  <div className="ratio-result-number">{ratio}{ratio !== "—" && "%"}</div>
                  <div className="ratio-result-label">Conversion</div>
                </div>
              </div>
              {loiCount > 0 && (
                <div className="ratio-bar-track">
                  <div className="ratio-bar-fill" style={{ width: `${Math.min((docsCount / loiCount) * 100, 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Task type breakdown */}
      <div className="metrics-section">
        <div className="metrics-section-title">Task Type Breakdown</div>
        {typeBreakdown.map((entry) => (
          <div key={entry.type} className="type-row">
            <span className="type-label">{entry.label}</span>
            <div className="leaderboard-bar-wrap">
              <div className={TYPE_BAR_CLASS[entry.type]} style={{ width: `${(entry.count / maxTypeCount) * 100}%` }} />
            </div>
            <span className="type-count">{entry.count}</span>
            <span className="type-pct">{entry.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── Admin panel (Users & Roles) ──────────────────────────── */
interface AdminUser {
  id: string;
  email?: string;
  displayName: string;
  roles: UserRole[];
  active: boolean;
  createdAt: string;
  lastSeenAt: string;
}

const ADMIN_ROLE_DEFS: { key: UserRole; label: string; cls: string }[] = [
  { key: "LOAN_OFFICER", label: "Loan Officer", cls: "lo" },
  { key: "FILE_CHECKER", label: "File Checker", cls: "fc" },
  { key: "ADMIN", label: "Admin", cls: "admin" }
];

interface SystemStatus {
  bot: { enabled: boolean; dmCount: number; channelCount: number };
  channelWebhook: boolean;
  activityFeed: boolean;
}

const botStatusView = (
  s: SystemStatus | null
): { label: string; cls: "ok" | "warn" | "off" } => {
  if (!s || !s.bot.enabled) return { label: "Not configured", cls: "off" };
  const reach = s.bot.dmCount + s.bot.channelCount;
  if (reach > 0) {
    return {
      label: `Connected · ${s.bot.dmCount} DM${s.bot.dmCount === 1 ? "" : "s"}, ${s.bot.channelCount} channel${s.bot.channelCount === 1 ? "" : "s"}`,
      cls: "ok"
    };
  }
  return { label: "Configured · no activity yet", cls: "warn" };
};

const AdminPanel = ({ user }: { user: UserIdentity }) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRoles, setAddRoles] = useState<UserRole[]>(["LOAN_OFFICER"]);
  const [adding, setAdding] = useState(false);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [channelBusy, setChannelBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const data = await apiRequest<{ users: AdminUser[] }>("/users", { method: "GET" }, user);
      setUsers(data.users);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load users");
    }
  };
  useEffect(() => {
    load().catch(() => {});
    apiRequest<SystemStatus>("/status", { method: "GET" }, user)
      .then(setStatus)
      .catch(() => setStatus(null));
    apiRequest<{ channels: Array<{ id: string; name: string }>; selected: string | null }>("/admin/channels", { method: "GET" }, user)
      .then((d) => { setChannels(d.channels); setSelectedChannel(d.selected); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeChannel = async (value: string): Promise<void> => {
    const channelId = value === "" ? null : value;
    setChannelBusy(true);
    try {
      const d = await apiRequest<{ selected: string | null }>("/admin/channels", { method: "PUT", body: JSON.stringify({ channelId }) }, user);
      setSelectedChannel(d.selected);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to set channel");
    } finally {
      setChannelBusy(false);
    }
  };

  const activeAdminCount = users.filter((u) => u.active && u.roles.includes("ADMIN")).length;

  const run = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      await load();
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  /* Taking away FILE_CHECKER — deactivating or removing someone — releases
     every live Fraud Check they were checking, because the seat needs the live
     role (ADR-0003). Say which ones first: the release is right, but it is not
     something an admin should discover afterwards. Returns false when they back
     out, and nothing is sent. */
  const confirmFraudCheckRelease = async (u: AdminUser, what: string): Promise<boolean> => {
    let tasks: Array<{ folderName: string }>;
    try {
      const data = await apiRequest<{ tasks: Array<{ folderName: string }> }>(`/users/${u.id}/fraud-checks`, { method: "GET" }, user);
      tasks = data.tasks;
    } catch {
      // Couldn't look. Still ask — proceeding silently is the thing this
      // confirm exists to prevent.
      return window.confirm(`${what} may release live fraud checks back to the pool, and we couldn't check which. Continue?`);
    }
    if (tasks.length === 0) {
      return true;
    }
    const names = tasks.slice(0, 5).map((t) => `· ${t.folderName}`).join("\n");
    const more = tasks.length > 5 ? `\n· …and ${tasks.length - 5} more` : "";
    return window.confirm(
      `${what} releases ${tasks.length} live fraud check${tasks.length === 1 ? "" : "s"} back to the pool:\n\n${names}${more}\n\nAny file checker can pick them up from where they are.`
    );
  };

  const toggleRole = (u: AdminUser, role: UserRole): void => {
    const has = u.roles.includes(role);
    const roles = has ? u.roles.filter((r) => r !== role) : [...u.roles, role];
    if (roles.length === 0) {
      setErr("A user needs at least one role.");
      return;
    }
    const losingCheckerRole = has && role === "FILE_CHECKER";
    void run(u.id, async () => {
      if (losingCheckerRole && !(await confirmFraudCheckRelease(u, `Taking FILE_CHECKER from ${u.displayName}`))) {
        return;
      }
      return apiRequest(`/users/${u.id}/roles`, { method: "PUT", body: JSON.stringify({ roles }) }, user);
    });
  };

  const setActive = (u: AdminUser, active: boolean): void => {
    void run(u.id, async () => {
      if (!active && !(await confirmFraudCheckRelease(u, `Deactivating ${u.displayName}`))) {
        return;
      }
      return apiRequest(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active }) }, user);
    });
  };

  const removeUser = (u: AdminUser): void => {
    if (!window.confirm(`Remove ${u.displayName}? This deletes their record and role assignments.`)) {
      return;
    }
    void run(u.id, async () => {
      if (!(await confirmFraudCheckRelease(u, `Removing ${u.displayName}`))) {
        return;
      }
      return apiRequest(`/users/${u.id}`, { method: "DELETE" }, user);
    });
  };

  const submitAdd = async (): Promise<void> => {
    const email = addEmail.trim();
    if (!email) return;
    setAdding(true);
    try {
      await apiRequest("/users", { method: "POST", body: JSON.stringify({ email, roles: addRoles }) }, user);
      setAddEmail("");
      setAddRoles(["LOAN_OFFICER"]);
      setAddOpen(false);
      await load();
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  };

  const toggleAddRole = (role: UserRole): void => {
    setAddRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  return (
    <div className="admin-panel">
      <div className="section-head">
        <h2>
          Users &amp; Roles
          <span className="section-count">
            {users.length} USERS · {activeAdminCount} ADMIN
          </span>
        </h2>
        <button type="button" className="btn-sm" onClick={() => setAddOpen((o) => !o)}>
          {addOpen ? "Cancel" : "+ Add User"}
        </button>
      </div>

      <div className="admin-status-bar">
        {(() => {
          const b = botStatusView(status);
          return (
            <span className={`admin-stat admin-stat-${b.cls}`} title="Teams bot connectivity">
              <span className="admin-stat-label">Bot</span>
              {b.label}
            </span>
          );
        })()}
        <span className={`admin-stat admin-stat-${status?.channelWebhook ? "ok" : "off"}`} title="Legacy incoming-webhook posts (separate from the bot). Bot channel posts use the Notification Channel below, not this.">
          <span className="admin-stat-label">Legacy webhook</span>
          {status?.channelWebhook ? "On" : "Off"}
        </span>
        <span className={`admin-stat admin-stat-${status?.activityFeed ? "ok" : "off"}`} title="Teams activity-feed notifications">
          <span className="admin-stat-label">Activity feed</span>
          {status?.activityFeed ? "On" : "Off"}
        </span>
      </div>

      {err && <p className="error-bar">{err}</p>}

      {addOpen && (
        <div className="admin-add-row">
          <input
            type="email"
            placeholder="name@loneoakfund.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitAdd(); }}
            autoFocus
          />
          <div className="admin-roles-cell">
            {ADMIN_ROLE_DEFS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`admin-role ${r.cls}${addRoles.includes(r.key) ? " on" : ""}`}
                onClick={() => toggleAddRole(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-sm btn-good" disabled={adding || !addEmail.trim()} onClick={() => void submitAdd()}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Roles · click to toggle</th>
            <th>Status</th>
            <th>Last seen</th>
            <th className="admin-manage-col">Manage</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.id === user.id;
            const rowClass = !u.active ? "admin-row-off" : "";
            return (
              <tr key={u.id} className={rowClass} aria-busy={busyId === u.id}>
                <td>
                  <div className="admin-uname">
                    {u.displayName}
                    {isSelf && <span className="admin-you">YOU</span>}
                  </div>
                  <div className="admin-umail">{u.email ?? u.id}</div>
                </td>
                <td>
                  <div className="admin-roles-cell">
                    {ADMIN_ROLE_DEFS.map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        className={`admin-role ${r.cls}${u.roles.includes(r.key) ? " on" : ""}`}
                        disabled={busyId === u.id}
                        onClick={() => toggleRole(u, r.key)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  <span className={`admin-status ${u.active ? "active" : "deact"}`}>
                    {u.active ? "Active" : "Deactivated"}
                  </span>
                </td>
                <td>
                  <span className="admin-seen" title={u.lastSeenAt ? formatDate(u.lastSeenAt) : undefined}>
                    {formatAgo(u.lastSeenAt)}
                  </span>
                </td>
                <td>
                  <div className="admin-actions">
                    {u.active ? (
                      <button
                        type="button"
                        className="admin-link warn"
                        disabled={busyId === u.id || isSelf}
                        onClick={() => setActive(u, false)}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="admin-link good"
                        disabled={busyId === u.id}
                        onClick={() => setActive(u, true)}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      type="button"
                      className="admin-link bad"
                      disabled={busyId === u.id || isSelf}
                      onClick={() => removeUser(u)}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="admin-empty">No users yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="admin-hint">
        New people auto-create as Loan Officer on first login. The last active admin
        can&rsquo;t be removed or demoted.
      </p>

      <div className="section-head">
        <h2>
          Notification Channel
          <span className="section-count">{channels.length} CHANNEL{channels.length === 1 ? "" : "S"}</span>
        </h2>
      </div>
      {channels.length === 0 ? (
        <p className="admin-hint">
          No channels yet — add the bot to a Teams channel and post once so it shows up here.
          Until one is chosen, group notifications go to every channel the bot is in.
        </p>
      ) : (
        <div className="admin-channel-row">
          <label>
            Group notifications go to
            <select
              value={selectedChannel ?? ""}
              disabled={channelBusy}
              onChange={(e) => void changeChannel(e.target.value)}
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
};

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  /* Selectable people for the share and handoff pickers (issue #41, ADR-0002).
     Active users; carries roles so the handoff picker can filter to file
     checkers on a Fraud Check. */
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  /* The mock switcher's roster (#309), dev only and empty until it lands. Held
     apart from `directory` above even though both are the active-user list:
     `directory` is fetched as the signed-in user and refetched whenever that
     changes, and the switcher needs its list BEFORE there is a user to fetch
     as. IS_DEV is statically false in a prod build, so this state, its fetch
     and the selector are all tree-shaken out of the bundle. */
  const [devUsers, setDevUsers] = useState<SwitchableUser[]>([]);
  /* Teams app id from GET /api/config — runtime config, not a build-time VITE_
     var, so the server can change it without rebuilding the bundle. null until
     the fetch lands (or when the server has no TEAMS_APP_ID), in which case
     "Copy link" falls back to the plain web URL. */
  const [teamsAppId, setTeamsAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Whether the New Task form is open. Only App state the create form needs —
     it flips on open/close, never per keystroke, so the whole form-input state
     lives in <CreateTaskForm> (issue #72) and App no longer re-renders (and
     re-renders the task list) as the user types. */
  const [formOpen, setFormOpen] = useState(false);
  /* Which task the edit form is open on (#260), or null. An id rather than the
     task itself: the list refreshes underneath, and holding the object would
     pin the form to a snapshot taken when the menu was clicked. */
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "metrics" | "admin">("active");

  /* Grouped ("courts") view toggle — buckets tasks by whose court the ball is
     in instead of one flat list. App-wide viewing preference, persisted so it
     survives reloads. Defaults on. */
  /* Theme: what the host asked for, what the person chose, and the one effect
     that decides which of the two wins. Splitting them is what lets "Match
     Teams" keep following live theme changes while a pinned choice ignores
     them. */
  const [hostTheme, setHostTheme] = useState<HostTheme>("light");
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(readThemeChoice);
  useEffect(() => {
    applyTheme(themeChoice === "auto" ? hostTheme : themeChoice);
  }, [themeChoice, hostTheme]);
  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_KEY, themeChoice);
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [themeChoice]);

  const GROUPED_KEY = "loan-tasks:grouped";
  const [grouped, setGrouped] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(GROUPED_KEY) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(GROUPED_KEY, grouped ? "true" : "false");
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [grouped]);

  /* Show: Everyone or Mine (#334), the stored half of the All Tasks and My
     Tasks tabs since #390. Same arrangement as Grouped/Flat above — per
     browser, survives a reload — and separate from it, since the two combine.
     Written only through `selectBoardTab` below. The rule itself is
     `board-filter.ts`. */
  const [boardShow, setBoardShow] = useState<BoardShow>(() => {
    try {
      return parseBoardShow(window.localStorage.getItem(BOARD_SHOW_KEY));
    } catch {
      return "everyone";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(BOARD_SHOW_KEY, boardShow);
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [boardShow]);

  /* History: how far back finished tasks go (#391). Same arrangement as Show —
     per browser, survives a reload, and storage that refuses is the default.
     The cutoff itself is `board-filter.ts`. */
  const [boardHistory, setBoardHistory] = useState<BoardHistory>(() => {
    try {
      return parseBoardHistory(window.localStorage.getItem(BOARD_HISTORY_KEY));
    } catch {
      return BOARD_HISTORY_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(BOARD_HISTORY_KEY, String(boardHistory));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [boardHistory]);

  /* Closed tasks a link opened from outside the History window (#391). They stay
     on the board for the session so the link lands on a card, and are never
     stored: a reload drops them, and the History setting is left alone. */
  const [keptTaskIds, setKeptTaskIds] = useState<ReadonlySet<string>>(() => new Set());

  /* The loan the Tasks board is narrowed to (#333). Session state and never
     stored, so a reload is the full board. The ref mirrors it for
     `setExpandOverride`, which has to keep an empty dependency list for the
     card memo and so cannot close over the state. */
  const [searchLoanId, setSearchLoanId] = useState<string | null>(null);
  const searchLoanIdRef = useRef<string | null>(null);
  searchLoanIdRef.current = searchLoanId;

  /* Which of the Tasks board's three tabs is open (#363, #390): All Tasks, My
     Tasks or Task Drafts. It opens on the stored Show value's tab, and choosing
     All or My writes that value back; Task Drafts has no stored half, so a
     reload never opens on it. The tab row, clearing a search, a link and the
     empty My Tasks state choose a tab through `selectBoardTab`. A loan pick is
     the one thing that sets the tab without storing it: it opens All Tasks for
     the search and remembers the tab it came from (`searchReturnTab`), which
     clearing goes back to. Opening or leaving the create form changes nothing,
     so a form closes back onto whichever tab it was opened from. */
  const [boardTab, setBoardTab] = useState<BoardTab>(() => tabForShow(boardShow));
  const selectBoardTab = useCallback((tab: BoardTab): void => {
    setBoardTab(tab);
    const show = showForTab(tab);
    if (show) setBoardShow(show);
  }, []);
  const [searchReturnTab, setSearchReturnTab] = useState<BoardTab>("all");

  /* Ticking clock for the live countdowns. Both views (flat and courts) use the
     same compact row, so this runs always. 30s cadence matches the granularity
     of the "Xh Ym" / "Nm" labels. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  /* Per-user "I've seen the latest note from someone else" map, keyed by
     task id → ISO timestamp of the latest non-self note already viewed.
     Persisted in localStorage so it survives reloads. */
  const seenNotesKey = `loan-tasks:seen-notes:${user.id}`;
  const loadSeenNotes = (uid: string): Record<string, string> => {
    try {
      const raw = window.localStorage.getItem(`loan-tasks:seen-notes:${uid}`);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const [seenNotesAt, setSeenNotesAt] = useState<Record<string, string>>(() => loadSeenNotes(user.id));
  /* Per-user accordion state: task id → true (the viewer opened it) / false
     (the viewer closed it). An absent entry is closed too — the map records
     the viewer's choices and nothing else decides. Persisted so those choices
     survive Teams tab reloads. */
  const expandKey = `loan-tasks:expand:${user.id}`;
  const loadExpand = (uid: string): ExpandOverrides => {
    try {
      const raw = window.localStorage.getItem(`loan-tasks:expand:${uid}`);
      return raw ? (JSON.parse(raw) as ExpandOverrides) : {};
    } catch {
      return {};
    }
  };
  const [expandOverrides, setExpandOverrides] = useState<ExpandOverrides>(() => loadExpand(user.id));
  /* Court holds (see `court-latch.ts`): tasks pinned to "Needs you" because
     the viewer opened them there. Session-only on purpose — a hold means
     "being read right now", so a reload ends it and the list re-sorts. */
  const [courtHolds, setCourtHolds] = useState<CourtHolds>({});
  /* Task to focus from a Teams deep link (bot card "Open in Hot Task" carries
     the task id as subEntityId). Held until the task is present in `tasks`,
     then expanded + scrolled into view by the effect below. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  /* The card the focus path wants on screen. A separate step from the focus
     itself because the focus changes what the board holds — it ends a loan
     search (#333) and can put Mine back to Everyone — and a scroll taken in the
     same pass aims at where the card sat on the old board. */
  const [scrollTaskId, setScrollTaskId] = useState<string | null>(null);
  /* Task to claim on arrival, set only by a link that carried the explicit
     claim intent — the channel card's "Claim & Open" (#180). Focus happens
     either way: the claim never blocks the navigation, and when it doesn't land
     the reason is a toast over a tab already open on the task. */
  const [claimOnArrivalId, setClaimOnArrivalId] = useState<string | null>(null);
  /* When the active user changes (mock user picker), reset the in-memory
     maps to that user's stored data BEFORE the writer effects run — so we
     don't clobber B's localStorage with A's state. setState during render is
     the React-supported way to derive state from a changing prop. */
  const [trackedUserId, setTrackedUserId] = useState(user.id);
  if (trackedUserId !== user.id) {
    setTrackedUserId(user.id);
    setSeenNotesAt(loadSeenNotes(user.id));
    setExpandOverrides(loadExpand(user.id));
  }
  useEffect(() => {
    try {
      window.localStorage.setItem(seenNotesKey, JSON.stringify(seenNotesAt));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [seenNotesAt, seenNotesKey]);
  const markNoteSeen = useCallback((taskId: string, at: string): void => {
    setSeenNotesAt((prev) => {
      const cur = prev[taskId];
      if (cur && cur >= at) return prev;
      return { ...prev, [taskId]: at };
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(expandKey, JSON.stringify(expandOverrides));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [expandOverrides, expandKey]);
  /* Opening a card is also where a court hold is taken and released (see
     `court-latch.ts`).

     `pulled` is passed IN rather than looked up here, and that is load-bearing,
     not a style choice. This callback rides in `cardProps` to every `TaskCard`,
     which is `React.memo`'d, so its identity has to be stable across renders —
     and `tasks` is replaced wholesale by every `refresh()`, which runs after
     essentially every mutation in the app. Closing over `tasks` to find the
     task by id therefore gave this a new identity after every action and
     re-rendered the entire list, defeating the memo for every card rather than
     just the one being opened. The caller is a card that already holds its own
     `task` and has already computed the answer; asking it costs nothing and
     keeps the dependency array empty. See the memo discipline in
     apps/web/CLAUDE.md — this is the exact trap it names.

     The card evaluates `pulled` at render, so it still reflects the state at the
     moment of the press: the header handler calls `acknowledgeUnread()` and
     `setExpanded(true)` in one event, and the value was read before either. */
  const setExpandOverride = useCallback((taskId: string, open: boolean, pulled?: boolean): void => {
    setExpandOverrides((prev) => ({ ...prev, [taskId]: open }));
    setCourtHolds((prev) =>
      open ? (pulled ? holdCourt(prev, taskId) : prev) : releaseCourt(prev, [taskId])
    );
    /* Opening a task from a narrowed board ends the search (#333), and it does
       so through the deep-link focus path below: that path clears the search,
       opens All Tasks if My Tasks would hide the task, and scrolls the card into
       view once the full board is back. The hold was taken just above with the
       card's own `pulled`, read at the press, so the row does not jump sections
       when the board fills in around it. From any tab, My Tasks included, though
       the search narrows All Tasks alone: opening a card is where a search ends,
       as it was before the tabs (the user's call on #390). */
    if (open && searchLoanIdRef.current) setFocusTaskId(taskId);
  }, []);
  /* Collapse all (#177): one merged write for the whole visible list, not one
     setState per card. The entries it adds are ordinary manual collapses,
     indistinguishable from clicking each row shut — and since nothing clears
     an expand behind the viewer any more (#161), they stay collapsed until the
     viewer opens them again. */
  const collapseAllTasks = useCallback((taskIds: string[]): void => {
    setExpandOverrides((prev) => collapseTasks(prev, taskIds));
    setCourtHolds((prev) => releaseCourt(prev, taskIds));
  }, []);
  /* Deep-link focus: once the linked task has loaded, jump to the main list,
     expand it, and scroll it into view. Waits for the task to be present so a
     cold open (tasks fetched after Teams init) still lands correctly. The rAF
     defers the scroll until the expanded card has rendered. */
  useEffect(() => {
    if (!focusTaskId || !tasks.some((t) => t.id === focusTaskId)) {
      return;
    }
    const target = focusTaskId;
    setActiveTab("active");
    /* Every arrival at a task ends a loan search (#333): opening a card from
       the narrowed board comes through here, and so does a link that lands
       mid-search, which could name a task on another loan and would otherwise
       open a card that is not on the board. The ref is cleared first so the
       expand below does not route back here. */
    searchLoanIdRef.current = null;
    setSearchLoanId(null);
    /* Same hold a click would take, so a bot link onto a task carrying an
       unread reply doesn't land you on it and then re-sort it out from under
       you. An effect may read `tasks` freely — unlike `setExpandOverride`, it
       is not a memoized prop, so nothing downstream depends on its identity. */
    const linked = tasks.find((t) => t.id === target);
    /* A link is a request to see this task, so it opens a task tab. It starts
       from the open tab, or mid-search from the tab clearing would return to,
       so opening a card and pressing Clear search leave a search the same way;
       from Task Drafts it starts on the stored tab. `searchLoanId` is this
       render's value, so ending the search above does not change it. From My
       Tasks, one the viewer only observes — a Share DM is the usual way here —
       would open a card that is not on the board and scroll to nothing, so the
       link opens All Tasks and stores it, the way pressing that tab would
       (#334, #390). */
    selectBoardTab(tabForLink({ from: searchLoanId ? searchReturnTab : boardTab, show: boardShow, onMineBoard: linked ? isOnMineBoard(linked, user) : true }));
    /* The same request past the History window (#391): a closed task older than
       the setting would open off the board and scroll to nothing. Unlike Mine,
       the setting is left alone; the task alone is kept, for the session. */
    if (linked && !isWithinHistory(linked, boardHistory, Date.now())) {
      setKeptTaskIds((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
    }
    setExpandOverride(target, true, linked ? hasUnreadNoteForViewer(linked, user, seenNotesAt[target]) : false);
    setScrollTaskId(target);
    setFocusTaskId(null);
  }, [focusTaskId, tasks]);
  /* The scroll, once the board it lands on has rendered: this runs on the commit
     after the focus path, when the search is gone and Show has settled, and the
     rAF waits for that layout to paint. The state is cleared inside the frame,
     not beside it. Clearing it in the effect body re-runs the effect before the
     frame and the cleanup cancels the scroll, which is how a card opened from a
     narrowed board used to stay wherever it had been. */
  useEffect(() => {
    if (!scrollTaskId || searchLoanId) return undefined;
    const target = scrollTaskId;
    /* Placed under the pinned header (#390) by `pinnedScrollTop`: centred in
       the room below it, or top-aligned under it when the opened card is taller
       than that room, which a plain `block: "center"` left hidden. */
    const raf = requestAnimationFrame(() => {
      const card = document.getElementById(`task-${target}`);
      if (card) {
        const box = card.getBoundingClientRect();
        const headerHeight = document.querySelector<HTMLElement>(".task-grid-head")?.offsetHeight ?? 0;
        window.scrollTo({
          top: pinnedScrollTop({ cardTop: box.top, cardHeight: box.height, headerHeight, viewportHeight: window.innerHeight, scrollY: window.scrollY }),
          behavior: "smooth"
        });
      }
      setScrollTaskId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTaskId, searchLoanId]);
  /* No effect clears a manual expand. There used to be one — a status change
     or a new note dropped the override so the default-open rule could
     re-decide — but with cards no longer opening themselves there is no rule
     to re-apply, and dropping the override just collapsed a card the viewer
     had deliberately opened. An expand is now the viewer's alone. */

  /* "Celebrating" — a task the current viewer created that just hit a
     completion milestone (COMPLETED, or LOAN_DOCS MERGE_DONE). The task
     pins to a celebrating bucket at the top of the grid while the
     status holds, and pulses green briefly when the transition lands.
     Pulse only fires for transitions observed during this session —
     never on initial page load. */
  const isCelebratingStatus = (t: LoanTask): boolean =>
    t.status === "COMPLETED" || (t.taskType === "LOAN_DOCS" && t.status === "MERGE_DONE");
  const [pulsingIds, setPulsingIds] = useState<Set<string>>(() => new Set());
  const prevStatusesRef = useRef<Map<string, TaskStatus>>(new Map());
  useEffect(() => {
    const next = new Map<string, TaskStatus>();
    const newlyPulsing: string[] = [];
    for (const t of tasks) {
      next.set(t.id, t.status);
      if (t.createdBy.id !== user.id) continue;
      if (!isCelebratingStatus(t)) continue;
      const prev = prevStatusesRef.current.get(t.id);
      if (prev !== undefined && prev !== t.status) {
        newlyPulsing.push(t.id);
      }
    }
    prevStatusesRef.current = next;
    if (newlyPulsing.length === 0) return;
    setPulsingIds((p) => {
      const merged = new Set(p);
      for (const id of newlyPulsing) merged.add(id);
      return merged;
    });
    const timer = setTimeout(() => {
      setPulsingIds((p) => {
        const merged = new Set(p);
        for (const id of newlyPulsing) merged.delete(id);
        return merged;
      });
    }, 3500);
    return () => clearTimeout(timer);
  }, [tasks, user.id]);
  /* Reset pulse + status snapshot on mock-user switch so a fresh viewer
     doesn't inherit the previous user's pulse state or transitions. */
  useEffect(() => {
    prevStatusesRef.current = new Map();
    setPulsingIds(new Set());
  }, [user.id]);

  const { showToast } = useToast();

  const isAdmin = user.roles.includes("ADMIN");

  useEffect(() => {
    if (!isAdmin && (activeTab === "metrics" || activeTab === "admin")) {
      setActiveTab("active");
    }
  }, [isAdmin, activeTab]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ tasks: LoanTask[] }>("/tasks", { method: "GET" }, user);
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    }
  }, [user]);

  const loadLoans = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ loans: Loan[] }>("/loans", { method: "GET" }, user);
      setLoans(data.loans);
    } catch {
      /* Loan typeahead is a convenience — a failed load just means no
         suggestions, so swallow rather than blocking the task view. */
    }
  }, [user]);

  /* The viewer's Saved for Later tasks (#343, ADR-0011): new tasks they put
     aside, kept on the server and seen by nobody else. Not tasks, so they live
     beside `tasks` rather than in it, and nothing that reads `tasks` — the
     counts, the courts, Flat view, admin metrics — can pick one up.

     `savedForLaterOwner` is whose list this is right now. The dev user picker
     can switch people while a load or a save is in flight, and an answer that
     comes back for the previous person must not land under the next one's
     name, which on a shared machine is the whole of the privacy promise. */
  const [savedForLater, setSavedForLater] = useState<SavedForLaterTask[]>([]);
  const savedForLaterOwner = useRef(user.id);
  /* The Saved for Later task the create form is open on, or null for a New Task
     (#344). Set only together with `formOpen`, and cleared when the form
     closes, so New Task never opens on a record left over from last time. */
  const [reopened, setReopened] = useState<SavedForLaterTask | null>(null);
  /* Whether a form is up, readable from inside an async handler. Tapping a row
     waits on a fetch, and a New Task opened during that wait must not have its
     typing swapped out for the record when the fetch lands. */
  const formOpenNow = useRef(formOpen);
  formOpenNow.current = formOpen;
  const loadSavedForLater = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ items: SavedForLaterTask[] }>("/saved-for-later", { method: "GET" }, user);
      if (user.id === savedForLaterOwner.current) setSavedForLater(data.items);
    } catch {
      /* The section is a convenience on top of the board, like the loan
         typeahead: a failed load leaves it hidden rather than blocking tasks,
         and the next load (sign-in, switching person) tries again. */
    }
  }, [user]);

  /* The viewer's autosave (#371): the new task form's typing, kept on the
     server like a Saved for Later task and listed beside them on the Task
     Drafts tab. Loaded with them, and again on the way into New Task so the
     form opens on the latest.

     Held as the newer of the server's copy and this browser's offline one, so
     typing the server never got still shows on the tab, and opens. A server
     that could not be asked leaves what App already held in the running. Same
     owner check as the list: an answer for the previous person is dropped. */
  const [autosave, setAutosave] = useState<Autosave | null>(null);
  const loadAutosave = useCallback(async (): Promise<void> => {
    const { reached, item } = await loadAutosaveRequest(savedForLaterRequestFor(user));
    if (user.id !== savedForLaterOwner.current) return;
    const offline = readDraftCopy(browserDraftStorage(), user.id);
    const at = Date.now();
    setAutosave((current) => {
      const best = newerAutosave(autosaveCopy(reached ? item : current, at), offline);
      return best ? { ownerId: user.id, savedAt: new Date(best.savedAt).toISOString(), form: best.values } : null;
    });
  }, [user]);

  /* Runtime client config. Unauthenticated and independent of SSO, so it runs
     on its own rather than waiting on the Teams handshake — /me stays about
     identity. A failure just leaves the app id null, which degrades "Copy
     link" to the web URL. */
  useEffect(() => {
    fetch(`${API_BASE}/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { teamsAppId?: string | null } | null) => {
        setTeamsAppId(data?.teamsAppId?.trim() || null);
      })
      .catch(() => {});
  }, []);

  /* Boot-time URL parsing: `#task-<id>` (what "Copy web link" produces) and
     `?taskId=<id>`. Both feed the same `focusTaskId` mechanism the Teams deep
     link uses, so the task is expanded + scrolled to once it has loaded — the
     browser's native fragment scroll silently no-ops when the task hasn't been
     fetched yet, is filtered out, or sits on another tab. */
  useEffect(() => {
    const fromHash = /^#task-(.+)$/.exec(window.location.hash)?.[1];
    const fromQuery = new URLSearchParams(window.location.search).get("taskId");
    const taskId = fromHash ?? fromQuery;
    if (taskId) {
      setFocusTaskId(taskId);
    }
  }, []);

  useEffect(() => {
    teamsApp
      .initialize()
      .then(async () => {
        const context = (await teamsApp.getContext()) as {
          app?: { theme?: string };
          theme?: string;
          page?: { subPageId?: string };
          subEntityId?: string;
        };
        setHostTheme(normalizeTheme(context.app?.theme ?? context.theme));
        teamsApp.registerOnThemeChangeHandler?.((theme) => setHostTheme(normalizeTheme(theme)));

        /* Deep link from a bot card → focus that task once it loads.
           teams-js v2 surfaces the link's subEntityId as page.subPageId. */
        const deepLinkTaskId = context.page?.subPageId ?? context.subEntityId;
        if (deepLinkTaskId) {
          setFocusTaskId(deepLinkTaskId);
          /* "Claim & Open" adds an explicit opt-in field beside subEntityId in
             the link's context; every other link this app builds or the bot
             sends carries no such field and stays view-only, so a link pasted
             into a chat never claims a task for whoever opens it (#180). */
          if (readClaimIntent(context)) {
            setClaimOnArrivalId(deepLinkTaskId);
          }
        }

        /* Deep link from the Humperdink userscript → open the create form, so
           the loan it just put on the clipboard has somewhere to be pasted
           (#198). An opt-in field of its own beside subEntityId: every other
           link this app builds or the bot sends carries no such field and lands
           on the normal board.

           Cold tab and warm tab are the same path on purpose. Hot Task doesn't
           opt into Teams tab caching — no `supportsCaching` in the manifest, no
           `app.notifySuccess` — so Teams loads the tab's content frame fresh
           for every deep link tap, and the context arrives here whether or not
           the tab was already open. That is the same assumption the task-focus
           link above has always run on.

           No `initialValues`: the link deliberately carries no data. The
           payload is on the clipboard and the filer presses paste — Hot Task
           never reads the clipboard itself (#194). */
        if (readCreateFormIntent(context)) {
          setFormOpen(true);
        }

        /* Teams host present → resolve the real identity via SSO. */
        const token = await authentication.getAuthToken();
        tokenCache.seed(token);
        const me = await apiRequest<UserIdentity>("/me", { method: "GET" }, INITIAL_USER);
        setUser(me);
      })
      .catch(() => {
        /* Plain browser (no Teams host) or SSO failure. In dev, keep the
           mock user + selector. In prod surface that sign-in is required.
           No Teams host means no theme signal either, so fall back to the
           OS/browser preference instead of hardcoding light. */
        setHostTheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        if (!IS_DEV) {
          setError("Unable to sign in. Open this app from Microsoft Teams.");
        }
      });
  }, []);

  useEffect(() => {
    /* Local dev only: fetch the switcher's roster and step into somebody
       (#309). This is the one request made before an identity exists, which is
       exactly why it goes to the unauthenticated dev route — asking an
       authenticated one would register the placeholder as a person and put it
       in the very list being read.

       `chooseDevUser` keeps the current id when the roster still has it, so a
       late-arriving roster never yanks the switcher off whoever is selected,
       and answers null for an empty roster, so a dev server that isn't up yet
       leaves the app as nobody rather than as a made-up somebody. */
    if (!IS_DEV) return;
    let live = true;
    loadDevUsers(API_BASE)
      .then((roster) => {
        if (!live) return;
        setDevUsers(roster);
        setUser((current) => chooseDevUser(roster, current.id) ?? current);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    /* Hold the first fetch until an identity resolves — the SSO token in prod,
       the dev roster locally. The placeholder user has an empty id (and
       dev-header auth would send a non-ASCII display name), so fetching now
       both 401s and risks a header encoding error. */
    /* Emptied before anything else, so one person's Saved for Later tasks are
       never on screen under the next person's name while theirs load. */
    savedForLaterOwner.current = user.id;
    setSavedForLater([]);
    setAutosave(null);
    if (!user.id) return;
    refresh().catch(() => {});
    loadLoans().catch(() => {});
    loadSavedForLater().catch(() => {});
    loadAutosave().catch(() => {});
  }, [user.id]);

  useEffect(() => {
    /* Load the people directory for the share picker (issue #41). Same
       gate as the task fetch: hold until a real identity resolves. */
    if (!user.id) return;
    apiRequest<{ users: DirectoryUser[] }>("/users/directory", { method: "GET" }, user)
      .then((data) => setDirectory(data.users))
      .catch(() => {});
  }, [user.id]);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/stream`);
    source.addEventListener("task.changed", (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LoanTask;
      setTasks((current) => {
        const idx = current.findIndex((t) => t.id === incoming.id);
        if (idx === -1) return [incoming, ...current];
        const copy = [...current];
        copy[idx] = incoming;
        return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    });
    return () => source.close();
  }, []);

  /* Create-form submit seam (issue #72). <TaskForm> owns the form state
     and builds the payload; App keeps the two side-effects — persistence and
     the post-create share — so the child stays presentational. Resolves once
     the task is persisted (the child then closes itself); rejects only when the
     create itself fails, after surfacing the error, so the form stays open. */
  const onCreate = async (payload: CreateTaskInput, shareWithUserId: string, note?: string, savedId?: string): Promise<void> => {
    let created: { task: LoanTask };
    try {
      created = await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create task", { variant: "error" });
      throw err;
    }
    setError(null);
    /* Filed from a reopened Saved for Later task (#344, ADR-0011 rule 4): the
       task exists, so the Saved for Later task goes. Only here, after the create
       landed: a filing that failed rethrew above and never reaches this, so the
       record is still there for the retry. The task was filed through the same
       request as any new task, with the same notifications, so a removal that
       fails cannot undo that and does not reject; it only says so. */
    if (savedId) {
      if (await removeSavedForLaterRequest(savedForLaterRequestFor(user), savedId)) {
        if (user.id === savedForLaterOwner.current) {
          setSavedForLater((current) => current.filter((item) => item.id !== savedId));
        }
      } else {
        showToast("Task created, but its Task Draft couldn't be removed.", { variant: "warn" });
      }
    }
    // Born assigned (ADR-0002): the handoff already happened inside the create
    // call, so there's nothing to fire here — just confirm it landed.
    if (payload.assigneeUserId) {
      const assignee = directory.find((u) => u.id === payload.assigneeUserId);
      showToast(`Created and handed to ${assignee ? firstName(assignee.displayName) : "them"} ✓`, { variant: "success" });
    }
    // "Make sure X sees this" (issue #46): the share has to fire AFTER the task
    // is persisted, so it's a follow-up call to #41's endpoint using the new
    // task id — deliberately decoupled so a failed/undelivered share never
    // blocks task creation. `delivered` tells us if the DM actually landed.
    // The outcome surfaces as a shared toast. A share failure here does not
    // reject — the task was created, so the form still closes.
    if (shareWithUserId) {
      const target = directory.find((u) => u.id === shareWithUserId);
      const targetName = target ? firstName(target.displayName) : "them";
      try {
        const { delivered } = await onShare(created.task.id, shareWithUserId, note);
        if (delivered) {
          showToast(`Sent ${targetName} a heads-up about this task ✓`, { variant: "success" });
        } else {
          showToast(
            `Task created, but we couldn't reach ${targetName} — have them message the bot first.`,
            { variant: "warn" }
          );
        }
      } catch {
        showToast(`Task created, but sharing with ${targetName} failed.`, { variant: "error" });
      }
    }
    await refresh();
    await loadLoans();
  };

  /* Save-for-later seam (#343), shaped like `onCreate`: the form hands over its
     values and closes itself once this resolves; a failure is toasted here and
     rethrown so the form stays open. The saved item goes straight into the list
     the section renders, so it is on the board the moment the form closes, with
     no reload. Nothing else is refreshed: saving files no task and touches no
     loan. */
  /* Since #344 a reopened form names its record, and the save lands on that one
     rather than making a copy. The request helper decides new-or-update, and
     keeps the typing as a new record if the old one went elsewhere; either way
     the saved record moves to the top of the list and replaces whatever it
     was reopened from. */
  const onSaveForLater = async (form: SavedForLaterForm, savedId?: string): Promise<void> => {
    let saved: SavedForLaterTask;
    try {
      saved = await saveForLaterRequest(savedForLaterRequestFor(user), form, savedId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save for later", { variant: "error" });
      throw err;
    }
    if (saved.ownerId === savedForLaterOwner.current) {
      setSavedForLater((current) => [saved, ...current.filter((item) => item.id !== saved.id && item.id !== savedId)]);
      /* A new form's typing was its autosave, and the server cleared that in the
         same write (#371), so the Autosaved row goes as the draft row arrives. */
      if (!savedId) setAutosave(null);
    }
  };

  /* Tapping a Saved for Later row (#344). Opens the create form on the latest
     save of that record rather than the list's copy, since another device may
     have saved it again since the board loaded. One that has gone (created or
     removed somewhere else) comes off the list with a word about why, instead
     of opening a form for a record that no longer exists. An answer that comes
     back after the person switched is dropped, like every Saved for Later load. */
  const openSavedForLater = useCallback(async (item: SavedForLaterTask): Promise<void> => {
    const latest = await reopenSavedForLaterRequest(savedForLaterRequestFor(user), item);
    if (user.id !== savedForLaterOwner.current) return;
    if (!latest) {
      setSavedForLater((current) => current.filter((saved) => saved.id !== item.id));
      showToast("That Task Draft is gone. It was created or removed somewhere else.", { variant: "warn" });
      return;
    }
    setSavedForLater((current) => current.map((saved) => (saved.id === latest.id ? latest : saved)));
    if (formOpenNow.current) return;
    setReopened(latest);
    setFormOpen(true);
  }, [user, showToast]);

  /* Deleting one from the board (#345), once the row's question was answered
     yes. For good: no undo. The server first, then the list, so a delete that
     did not land leaves the row where it was, with a word about it. One already
     gone (created or deleted on another device) counts as deleted. The count
     and the section's hiding follow the list on their own. An answer that comes
     back after the person switched is dropped, like every Saved for Later load.
     Resolves true only when the row was taken off, which is how the section
     knows to move focus on to the next row. */
  const deleteSavedForLater = useCallback(async (item: SavedForLaterTask): Promise<boolean> => {
    const removed = await removeSavedForLaterRequest(savedForLaterRequestFor(user), item.id);
    if (user.id !== savedForLaterOwner.current) return false;
    if (!removed) {
      showToast("Couldn't delete that Task Draft. Try again.", { variant: "error" });
      return false;
    }
    setSavedForLater((current) => current.filter((saved) => saved.id !== item.id));
    return true;
  }, [user, showToast]);

  /* A reopened form's typing, kept on its record as it is typed (#348,
     ADR-0011 rule 5). Silent, and the board's list is left alone: this runs
     every time somebody pauses, and re-rendering the board for it would undo
     what lifting the form out of App was for (#72). Reopening fetches the
     latest record anyway. Stable per person, so the form's timer is not reset
     by an unrelated App render. */
  const onKeepUnsaved = useCallback(async (savedId: string, form: SavedForLaterForm): Promise<boolean> => {
    return keepUnsavedRequest(savedForLaterRequestFor(user), savedId, form);
  }, [user]);

  /* Throwing that typing away, leaving the save as it was (#348), when a
     reopened form is typed back to exactly its save. Silent here too. Discard
     no longer uses it: since #388 a confirmed Discard deletes the record
     (`onDeleteReopened`, below). */
  const onDiscardUnsaved = useCallback(async (savedId: string): Promise<boolean> => {
    return discardUnsavedRequest(savedForLaterRequestFor(user), savedId);
  }, [user]);

  /* Discard on a reopened Task Draft, once its delete question was answered
     Delete (#388). The same removal the row's delete control and Create use,
     so one already gone counts as deleted. The row leaves the tab, and the
     count with it, only when the server let it go and only for the person it
     belongs to, the row's own owner check. Silent: the form says when it did
     not land. */
  const onDeleteReopened = useCallback(async (savedId: string): Promise<boolean> => {
    const removed = await removeSavedForLaterRequest(savedForLaterRequestFor(user), savedId);
    if (removed && user.id === savedForLaterOwner.current) setSavedForLater((current) => current.filter((saved) => saved.id !== savedId));
    return removed;
  }, [user]);

  /* Opening New Task (#371). The button and the Task Drafts tab's Autosaved row
     are the same way in, so tapping the row opens exactly what New Task would.
     The latest autosave is asked for first, so typing done on another device
     since sign-in is what the form opens on; a server that does not answer in
     time opens on what App already holds. A form opened while that was out is
     left alone. */
  const openNewTask = useCallback(async (): Promise<void> => {
    setReopened(null);
    await loadAutosave();
    if (formOpenNow.current) return;
    setFormOpen(true);
  }, [loadAutosave]);

  /* A new task form's typing, written to the server's autosave as it is typed
     (#371). Silent, and the board is left alone, for the reason
     `onKeepUnsaved` is: it runs every time somebody pauses. */
  const onKeepAutosave = useCallback(async (form: SavedForLaterForm): Promise<boolean> => {
    return keepAutosaveRequest(savedForLaterRequestFor(user), form);
  }, [user]);

  /* A new task form forgetting its autosave: filed, discarded, Start fresh,
     saved for later, or emptied back out. The Autosaved row goes with it. Silent
     when the server could not forget it; the form has already cleared this
     browser's copy. */
  const onForgetAutosave = useCallback(async (): Promise<boolean> => {
    if (user.id === savedForLaterOwner.current) setAutosave(null);
    return forgetAutosaveRequest(savedForLaterRequestFor(user));
  }, [user]);

  /* The Autosaved row's delete (#371), once its question was answered yes. The
     server first, then this browser's offline copy and the row, so a delete that
     did not land leaves the row where it was, with a word about it, the way a
     draft's does. */
  const deleteAutosave = useCallback(async (): Promise<boolean> => {
    const removed = await forgetAutosaveRequest(savedForLaterRequestFor(user));
    if (user.id !== savedForLaterOwner.current) return false;
    if (!removed) {
      showToast("Couldn't delete the autosaved task. Try again.", { variant: "error" });
      return false;
    }
    clearDraft(browserDraftStorage(), user.id);
    setAutosave(null);
    return true;
  }, [user, showToast]);

  const onClaim = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/claim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to claim task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* Claim on arrival, for a deep link that carried the claim intent — the
     channel card's "Claim & Open" (#180).

     The same `onClaim` every other claim in the app goes through, so there is
     one POST, one refresh and one failure surface: `canClaimTask` stays the
     only authority on whether a claim is allowed, and the sentence it refuses
     with — someone else got there first, the task has left play, or you created
     it (ADR-0003) — is what the toast says. Nothing here re-decides
     eligibility, and nothing here blocks: the focus effect has already opened
     the tab on the task, so a refusal lands beside it rather than in front
     of it.

     Deliberately not waiting for the task to appear in `tasks`. A task the
     viewer's list doesn't hold — filtered out, or aged past the closed-task
     window — would otherwise be claimed silently and never reported, and the
     refusal reads off the server's answer rather than off the local snapshot
     anyway. It does wait for an identity — the placeholder has no id, and the
     request would either 401 (prod, before SSO) or claim the task for a person
     who isn't the one about to be selected (dev, before the roster lands).

     The ref is what makes it one shot. StrictMode runs a mount effect twice in
     dev, and both passes see the same state. */
  const claimedOnArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!claimOnArrivalId || !user.id) {
      return;
    }
    if (claimedOnArrival.current === claimOnArrivalId) {
      return;
    }
    claimedOnArrival.current = claimOnArrivalId;
    const taskId = claimOnArrivalId;
    setClaimOnArrivalId(null);
    void onClaim(taskId);
  }, [claimOnArrivalId, user, onClaim]);

  const onUnclaim = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/unclaim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to unclaim task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  const onTransition = useCallback(async (taskId: string, status: TaskStatus, reviewNotes?: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ status, ...(reviewNotes ? { reviewNotes } : {}) }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* FRAUD "release for any fraud checker" (#39): the requester hands a
     PENDING_APPROVAL task back to the checker pool (server unassigns it, keeps
     it PENDING_APPROVAL) so final approval isn't stuck on one checker. */
  const onRelease = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/release`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to release task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* #208: the creator puts their own request back in the pool, taking it off a
     holder who has stalled on it. The counterpart to the handoff now that nobody
     may hand a task to themselves. */
  const onReturnToPool = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/return-to-pool`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to return the task to the pool", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  const onAddReviewNote = useCallback(async (taskId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/review-note`, { method: "POST", body: JSON.stringify({ text }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to add review note", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* Correct a message you posted (#287, ADR-0009). One narrow POST on the
     message's own identifier, then the usual refresh.

     No toast on success, deliberately. Every other write here that people watch
     for announces itself; a correction is explicitly not news (rule 6), and the
     row redrawing with the new words and an `(edited)` marker is the whole of
     the feedback. A refusal still toasts — the author-only rule and the
     archived gate are enforced server-side, so a client that somehow asked
     anyway has to be told why it was refused.

     And the refusal is re-thrown after the toast, which is the one place this
     handler differs from its neighbours. They all fire and forget; this one is
     awaited by an open text box holding what the person typed, and that box has
     to know not to close. The toast says why; the draft survives to be fixed. */
  const onEditMessage = useCallback(async (taskId: string, messageId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(
        `/tasks/${taskId}/messages/${messageId}/text`,
        { method: "POST", body: JSON.stringify({ text }) },
        user
      );
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to edit the message", { variant: "error" });
      throw err;
    }
  }, [user, refresh, showToast]);

  /* Withdraw a message you posted (#288, ADR-0009 rule 4). The edit's twin: one
     narrow request on the message's own identifier, then the usual refresh, and
     silence on success for the same reason — the row redrawing as `Message
     deleted` is the whole of the feedback, and a toast announcing it would be
     the app being noisier about a withdrawal than it is about the message.

     Re-thrown after the toast like the edit, because the menu that called it is
     waiting to know whether to close. */
  const onDeleteMessage = useCallback(async (taskId: string, messageId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/messages/${messageId}`, { method: "DELETE" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete the message", { variant: "error" });
      throw err;
    }
  }, [user, refresh, showToast]);

  /* Add a note to a COMPLETED task (#45). Hits the server-atomic endpoint that
     appends the note while keeping the task COMPLETED — no visible reopen. */
  const onAddCompletedNote = useCallback(async (taskId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/completed-note`, { method: "POST", body: JSON.stringify({ text }) }, user);
      await refresh();
      showToast("Note added", { variant: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to add note", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* FRAUD structured checklist (#44). One handler per atomic endpoint; each
     refreshes so the live task (and SSE-driven cards) reflect the change. Errors
     surface as a toast — the server is the authority on turn/permission, so a
     rejected op just tells the user it isn't their turn. Bundled into one object
     so the card only takes a single prop. */
  const runChecklist = useCallback(async (path: string, body: unknown, fallback: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(path, { method: "POST", body: JSON.stringify(body) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : fallback, { variant: "error" });
    }
  }, [user, refresh, showToast]);
  const deleteChecklist = useCallback(async (path: string, fallback: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(path, { method: "DELETE" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : fallback, { variant: "error" });
    }
  }, [user, refresh, showToast]);
  /* Memoized so the object identity is stable across renders (#73) — a fresh
     literal every render would defeat TaskCard's memo for every card. */
  const checklistApi = useMemo<ChecklistApi>(() => ({
    addItem: (taskId, text) => runChecklist(`/tasks/${taskId}/checklist/items`, { text }, "Failed to add item"),
    editText: (taskId, itemId, text) => runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/text`, { text }, "Failed to edit item"),
    deleteItem: (taskId, itemId) => deleteChecklist(`/tasks/${taskId}/checklist/items/${itemId}`, "Failed to delete item"),
    toggle: (taskId, itemId, checked, note) =>
      runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/checked`, { checked, ...(note !== undefined ? { note } : {}) }, "Failed to update item"),
    setNote: (taskId, itemId, note) => runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/note`, { note }, "Failed to save note")
  }), [runChecklist, deleteChecklist]);

  /* The merge question, while it is on screen (#265, ADR-0008 rule 7). Holds
     the loan being merged into — so the dialog can name it — and the resolver
     that hands the answer back to the save that is waiting on it. */
  const [mergeAsk, setMergeAsk] = useState<{
    collision: LoanLinkCollision;
    decide: (confirmed: boolean) => void;
    /* The save carried the loan's own link only because another record holds
       it (#383), so the dialog must not say the person changed it. */
    linkUntouched: boolean;
  } | null>(null);
  const [merging, setMerging] = useState(false);

  /* The single door every loan edit goes through. Two surfaces used to call it;
     since #266 there is one, because the loan-filter header no longer edits
     anything — but the door stays a door, so the confirmation below is written
     once whatever comes to use it next.

     Every body sent through here carries the `taskId` its caller was editing
     from, and the server checks the party rule on each request — including the
     `confirmMerge` re-send, which is the same body a second time. A refusal that
     only arrived after the dialog would be a refusal someone had to answer a
     question to discover.

     A save posts exactly what it always did. If the link lands on another loan's
     the server writes nothing and answers 409 naming that loan (#262); we ask
     about that loan by name, and only a yes re-sends the identical change with
     `confirmMerge`, at which point the merge runs as it always has. A no sends
     nothing at all — both records and the link are exactly as they were — and
     rejects, so the caller leaves its form open with the typing still in it. */
  const patchLoan = useCallback(async (
    loanId: string,
    body: Record<string, unknown>,
    ask?: { linkUntouched: true }
  ): Promise<LoanPatchResult> => {
    const send = (extra?: Record<string, unknown>) =>
      apiRequest<LoanPatchResult>(
        `/loans/${loanId}`,
        { method: "PATCH", body: JSON.stringify({ ...body, ...extra }) },
        user
      );
    try {
      return await send();
    } catch (err) {
      const collision = linkCollisionIn(err);
      if (!collision) throw err;
      const confirmed = await new Promise<boolean>((decide) =>
        setMergeAsk({ collision, decide, linkUntouched: Boolean(ask?.linkUntouched) })
      );
      if (!confirmed) {
        setMergeAsk(null);
        throw new MergeDeclined();
      }
      // The dialog stays up, busy, until the merge lands: it is the only thing
      // on screen saying what is happening to the other loan's tasks.
      setMerging(true);
      try {
        const result = await send({ confirmMerge: true });
        /* ADR-0001's transient notice (addendum 2026-07-31), said once here
           rather than once per calling surface: the dialog asked and closed, and
           this is what says the merge actually happened. It belongs to the step
           that merged, not to whoever started the save — a third editing surface
           should inherit it without remembering to. */
        if (result.merged) {
          showToast(
            `Merged with "${result.merged.intoLoanName}", an existing loan sharing this Humperdink link.`,
            { variant: "info" }
          );
        }
        return result;
      } finally {
        setMerging(false);
        setMergeAsk(null);
      }
    }
  }, [user, showToast]);

  /* `onSaveLoan` — the loan-filter header's save — is gone with #266. That
     header sits outside any task, so under ADR-0008 rule 5 there is nobody to
     check and it carries no edit at all now. `saveLoanFields` below is the one
     remaining caller of `patchLoan`, and it always has a task behind it. */

  /* The web app's first caller of GET /tasks/:id/history (ADR-0002 noted it had
     none). `useMemo`'d for the same reason `amendApi` is: a fresh literal every
     render would defeat TaskCard's memo across the whole list.

     It resolves to `undefined` on failure instead of rethrowing — the only
     consumer is a timestamp line that is allowed to be absent, and a toast for
     a reference detail nobody asked for out loud would be worse than the
     missing line. `undefined` rather than `[]` so the caller can tell "we could
     not read it" from "the task genuinely has no history": both render the same
     nothing, but only the first is worth retrying. */
  const taskHistoryApi = useMemo<TaskHistoryApi>(() => ({
    read: async (taskId) => {
      try {
        const { history } = await apiRequest<{ history: TaskHistoryEvent[] }>(`/tasks/${taskId}/history`, { method: "GET" }, user);
        return history;
      } catch {
        return undefined;
      }
    }
  }), [user]);

  /* Amend the ask (ADR-0006, and ADR-0008 rule 4's replacement for it). One
     call per field, mirroring the server's one route per field — nothing here
     can express a due date, because no route accepts one, and there is
     deliberately nothing that can post a whole task at once.

     All of them rethrow after toasting: the edit form holds a draft, so a
     refused save has to leave it open with the text still in it rather than
     swallow the rejection and close over the creator's typing. The form is the
     only web path to the poops since #335 retired the card's click-to-rate
     track.

     None of them refreshes. A save can call two or three of them and the list
     is the same list afterwards either way, so the refetch belongs once at the
     end of the save, not once per field — see `onSaveEdit`. */
  const amendApi = useMemo<AmendApi>(() => {
    const amend = async (taskId: string, field: string, body: unknown, noun: string): Promise<void> => {
      try {
        await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/${field}`, { method: "POST", body: JSON.stringify(body) }, user);
      } catch (err) {
        showToast(err instanceof Error ? err.message : `Failed to update ${noun}`, { variant: "error" });
        throw err;
      }
    };
    return {
      setNotes: (taskId, notes) => amend(taskId, "notes", { notes }, "notes"),
      setUrgency: (taskId, urgency) => amend(taskId, "urgency", { urgency }, "urgency"),
      setPoints: (taskId, points) => amend(taskId, "points", { points }, "poops"),
      setFolderName: (taskId, folderName) =>
        amend(taskId, "folder-name", { folderName }, "the description"),
      setDates: (taskId, dates) => amend(taskId, "dates", dates, "dates")
    };
  }, [user, showToast]);

  /* Save the Instructions box from the box itself (#303, ADR-0010 rule 4).

     The second door onto the field, and deliberately the same route as the
     first: `amendApi.setNotes` is what the edit form's save reaches through
     `saveTaskEdit`, so one press here and one press there produce the same
     write, the same history entry and the same DM. Two doors onto one field was
     the risk ADR-0008 rule 4 refused; sharing the route — and the one shared
     permission rule both surfaces gate on — is how ADR-0010 accepts it.

     `amendApi` toasts and rethrows already. The refresh is added here because
     unlike the form's save — which refetches once for a save that may have
     touched four fields — this one writes exactly one field and has no other
     step to hang the refetch on. It rethrows, so the box stays open with the
     rewrite still in it when the write is refused. */
  const onSaveInstructions = useCallback(async (taskId: string, text: string): Promise<void> => {
    await amendApi.setNotes(taskId, text);
    await refresh();
  }, [amendApi, refresh]);

  /* Write the shared Loan record from the edit form (#262, ADR-0008 rule 7).

     The task it was edited from travels with it (#266): the server's permission
     rule is "is this person a party to this task, and is the task on this loan",
     so the task id is not context for the log, it is the thing being checked.
     There is no way to reach this without one — the only caller is the edit
     form, which is always open on a task.

     The server pushes the new name and link onto every task on the loan, so the
     refresh below is what makes the whole list agree — not just the task the
     form was open on. A refusal (a link already on another loan, #262's 409) is
     toasted and rethrown, so the form stays open with the typing still in it. */
  const saveLoanFields = useCallback(async (loanId: string, taskId: string, fields: { name?: string; humperdinkLink?: string }, ask?: { linkUntouched: true }): Promise<void> => {
    const link = fields.humperdinkLink?.trim();
    try {
      await patchLoan(loanId, {
        taskId,
        ...(fields.name !== undefined ? { name: fields.name.trim() } : {}),
        // Saved straight from the keyboard, the field's own blur-time
        // prefixing may never have run. Normalized here so a bare host isn't
        // stored as a relative link.
        ...(fields.humperdinkLink !== undefined
          ? { humperdinkLink: link && !/^https?:\/\//i.test(link) ? `https://${link}` : link }
          : {})
      }, ask);
      /* The task list is refetched by the caller, once for the whole save
         (#261) — refetching it here as well would fetch it twice for any save
         that touched the loan fields. The loan list is this step's own and has
         no other refresher. */
      await loadLoans();
    } catch (err) {
      /* A declined merge is not a failure — nothing was sent — so it gets no
         toast. It still rejects, which is what keeps the form open with the
         typing in it, the same as a refusal does. */
      if (!(err instanceof MergeDeclined)) {
        showToast(err instanceof Error ? err.message : "Failed to update the loan", { variant: "error" });
      }
      throw err;
    }
  }, [patchLoan, loadLoans, showToast]);

  /* Open the edit form (#260). `useCallback` because every card holds this and
     a fresh literal per render would defeat TaskCard's memo across the list. */
  const onEditTask = useCallback((taskId: string): void => setEditingTaskId(taskId), []);

  /* Save an edit (#260, #262, extended by #261, #264 and #281). The dispatch
     itself — which record each field lands on, and in what order — is
     `saveTaskEdit`, which lives outside this file so it can be driven in a test
     rather than read as source. What stays here is what belongs to the shell:
     the api calls it hands over, the one refetch, and the one refusal it raises
     itself rather than receives.

     One refresh at the end covers however many writes ran — several refetches
     of the same list would be several too many, and a save that stopped partway
     still refetches on the way out so the row shows what actually landed. Since
     #281 the write that can stop partway is only ever a genuine failure: the
     one that asks a question asks it before anything is written.

     The form never calls it with an empty edit, so a save that changed nothing
     makes no request at all: no history entry and no DM. Rejects on failure,
     after the api layer has toasted, so the form stays open with the creator's
     typing still in it. */
  const onSaveEdit = useCallback(async (task: LoanTask, edit: TaskEdit): Promise<void> => {
    try {
      /* The loan's link rides along on any save when another loan record holds
         it (#383), so the merge question can reach the pair; a person the loan
         fields are shut to never sends it. Read from the loan list this app
         already holds — a stale list sends a link that changes nothing. */
      await saveTaskEdit(task, edit, { ...amendApi, saveLoanFields }, {
        sharedLink: sharedLinkOf(task.loanId, loans),
        loanLocked: Boolean(loanEditRefusal(task, user))
      });
    } catch (err) {
      /* The only refusal raised at this level rather than received from a
         request, so it is the only one with nobody behind it to have spoken.
         Everything else has already been toasted by the call that failed — or
         is a declined merge, which sent nothing and is silent on purpose. */
      if (err instanceof NoLoanToCorrect) showToast(err.message, { variant: "error" });
      throw err;
    } finally {
      await refresh();
    }
  }, [amendApi, saveLoanFields, showToast, refresh, loans, user]);

  /* The task the edit form is open on, resolved fresh out of the list every
     render. `tasks` is the whole store — the board is filtered from it — so an
     id that came off any row resolves here. */
  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) : undefined;

  /* Whether this viewer may correct the loan behind the task they have open, and
     if not, why (#266, ADR-0008 rule 5). Resolved out of `editingTask` rather
     than out of the form's copy so it re-answers when the task moves underneath
     the open form — a handoff mid-edit takes the assignee seat away, and the
     boxes should shut when it does. */
  const editingLoanRefusal = editingTask ? loanEditRefusal(editingTask, user) : undefined;

  /* Share a task with one person (issue #41). Returns whether the DM actually
     reached them (they may have no bot reference), so the card can distinguish
     "sent ✓" from a "couldn't reach them" heads-up. Rethrows on request failure
     so the card can flash an inline error next to the picker. */
  const onShare = useCallback(async (taskId: string, targetUserId: string, note?: string): Promise<{ delivered: boolean }> => {
    try {
      const res = await apiRequest<{ ok: true; delivered: boolean }>(
        `/tasks/${taskId}/share`,
        { method: "POST", body: JSON.stringify({ targetUserId, ...(note ? { note } : {}) }) },
        user
      );
      setError(null);
      return { delivered: res.delivered };
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to share task", { variant: "error" });
      throw err;
    }
  }, [user, showToast]);

  /* Hand a task to someone else (ADR-0002). Rethrows the server's message so
     the popover can show a refusal (ineligible recipient, closed task, lost
     race) inline next to the picker — no toast here, the popover owns both
     outcomes. */
  const onAssign = useCallback(async (taskId: string, assigneeUserId: string, note?: string): Promise<void> => {
    await apiRequest<{ task: LoanTask }>(
      `/tasks/${taskId}/assign`,
      { method: "POST", body: JSON.stringify({ assigneeUserId, ...(note ? { note } : {}) }) },
      user
    );
    setError(null);
    await refresh();
  }, [user, refresh]);

  /* Every task the client holds, sorted, with nothing cut: the History window is
     applied in `visibleBoardTasks`, so the loan search can see past it (#391).
     Fraud Check claims are gated to FILE_CHECKERs in the workflow; the UI just
     hides the Claim button for viewers who can't act. Sort: celebrating
     (creator-only completion milestone) pinned to the very top → OPEN →
     in-flight → closed mini rows, newest-first within each bucket. */
  const unifiedTasks = useMemo(() => {
    const bucket = (t: LoanTask): number => {
      if (t.createdBy.id === user.id && isCelebratingStatus(t)) return 0;
      if (t.status === "OPEN") return 1;
      if (CLOSED_STATUSES.includes(t.status)) return 3;
      return 2;
    };
    return [...tasks].sort((a, b) => {
      const diff = bucket(a) - bucket(b);
      if (diff !== 0) return diff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [tasks, user.id]);

  /* What the Tasks board actually renders: `unifiedTasks` cut to the History
     window (less any task a link kept) and narrowed by Show, or by a picked
     loan, which ignores both. The heading, its count, the sections, Done, the
     empty state and Collapse all all read this one list, so they cannot
     describe different sets. Any further narrowing of the board goes through
     `visibleBoardTasks`, not beside it. The cutoff is measured when the list
     changes, the same as the fixed window it replaced. */
  /* A search whose loan has gone (merged into another since it was picked)
     resolves to nothing, and the board is simply full again. */
  const searchLoan = useMemo(
    () => (searchLoanId ? loans.find((l) => l.id === searchLoanId) ?? null : null),
    [searchLoanId, loans]
  );
  /* Both task tabs, each counted whichever is open (#390). The search goes to
     both and `visibleBoardTasks` applies it to All Tasks alone. `boardTasks` is
     the one the open tab renders; on Task Drafts it is All Tasks, which nothing
     there reads. */
  const allBoardTasks = useMemo(() => visibleBoardTasks(unifiedTasks, { show: "everyone", viewer: user, loanId: searchLoan?.id ?? null, history: boardHistory, now: Date.now(), keep: keptTaskIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unifiedTasks, user.id, searchLoan, boardHistory, keptTaskIds]);
  const mineBoardTasks = useMemo(() => visibleBoardTasks(unifiedTasks, { show: "mine", viewer: user, loanId: searchLoan?.id ?? null, history: boardHistory, now: Date.now(), keep: keptTaskIds }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unifiedTasks, user.id, searchLoan, boardHistory, keptTaskIds]);
  const boardTasks = boardTab === "mine" ? mineBoardTasks : allBoardTasks;
  /* The search's empty-box shortlist, the same "mine" the create form derives. */
  const searchMyLoanIds = useMemo(() => deriveMyLoanIds(tasks, user.id), [tasks, user.id]);

  /* The admin-only Tasks tab counts the unfiltered board on purpose (#334): the
     tab names the list, and Mine is a view over it. */
  const activeCount = useMemo(() => unifiedTasks.filter((t) => !CLOSED_STATUSES.includes(t.status)).length, [unifiedTasks]);

  /* Re-bucket an already-filtered task list (History window applied)
     into the grouped view's courts. A completion the viewer created pins to a
     "Just finished" section at the very top (kept until they archive it) and
     is held out of Done so it isn't listed twice; everyone else's completions
     fall into Done. Active courts sort soonest-due first, Done newest-first. */
  type CourtSection = { key: string; title: string; tasks: LoanTask[] };
  const buildCourtSections = (list: LoanTask[]): CourtSection[] => {
    const celebrating: LoanTask[] = [];
    const you: LoanTask[] = [];
    const pool: LoanTask[] = [];
    const them: LoanTask[] = [];
    const done: LoanTask[] = [];
    for (const t of list) {
      // "Finished" celebrates only truly-done work the viewer created. A
      // LOAN_DOCS task at MERGE_DONE still needs the creator's Approve, so it
      // falls through to its court ("Needs you") instead of being mislabeled as
      // finished — the brief green pulse still fires via pulsingIds.
      if (t.createdBy.id === user.id && t.status === "COMPLETED") {
        celebrating.push(t);
        continue;
      }
      let court = courtOf(t, user);
      // Message pull (CONTEXT.md): an unread reply from the other party
      // temporarily pulls a task into the recipient's "Needs you", even when
      // they don't own the current section. Only ever ADDS a court, never
      // removes one. Asks the same shared predicate the card's red dot asks,
      // so a Party's bucket and their dot cannot drift apart — the party gate
      // ("an Observer has no move") lives inside it now rather than being
      // restated here, which is how the card came to be missing it (#161).
      // A held court (court-latch.ts) is the same pull, kept alive while the
      // viewer has the card open. Reading it inside this branch and no other
      // is what keeps "only ever ADDS a court, never removes one" true of the
      // hold as well: a task that closes while open still falls to "done",
      // because `courtOf` never returns "them"/"pool" for a closed task.
      if (court === "them" || court === "pool") {
        if (hasUnreadNoteForViewer(t, user, seenNotesAt[t.id]) || isCourtHeld(courtHolds, t.id)) {
          court = "you";
        }
      }
      if (court === "you") you.push(t);
      else if (court === "pool") pool.push(t);
      else if (court === "them") them.push(t);
      else done.push(t);
    }
    const byRecent = (a: LoanTask, b: LoanTask): number =>
      new Date(b.completedAt ?? b.updatedAt).getTime() - new Date(a.completedAt ?? a.updatedAt).getTime();
    // #133: two-tier — a live deadline outranks a paused (FRAUD AWAITING_ITEMS)
    // task, whose dueAt is a dead clock that would otherwise float it to the top.
    you.sort(byAttentionClaim);
    pool.sort(byAttentionClaim);
    them.sort(byAttentionClaim);
    done.sort(byRecent);
    celebrating.sort(byRecent);
    const sections: CourtSection[] = [];
    if (celebrating.length) sections.push({ key: "celebrating", title: "Finished", tasks: celebrating });
    sections.push({ key: "you", title: "Needs you", tasks: you });
    sections.push({ key: "pool", title: "Up for grabs", tasks: pool });
    sections.push({ key: "them", title: "In flight", tasks: them });
    sections.push({ key: "done", title: "Done", tasks: done });
    return sections;
  };

  /* Which tasks in a given list are open right now — the input to that list's
     Collapse all. Reads the same map TaskCard renders by, so the button can
     never be live while every card below it is already closed. One pass of map
     lookups over the rendered page, so it runs unmemoized. */
  const expandedIdsIn = (list: LoanTask[]): string[] => expandedTaskIds(list, expandOverrides);
  const renderTaskList = (list: LoanTask[], emptyMessage: string) => {
    const cardProps = {
      user,
      onClaim,
      onUnclaim,
      onReturnToPool,
      onTransition,
      onRelease,
      onAddReviewNote,
      onEditMessage,
      onDeleteMessage,
      onSaveInstructions,
      onAddCompletedNote,
      onEditTask,
      taskHistory: taskHistoryApi,
      onShare,
      onAssign,
      checklist: checklistApi,
      directory,
      teamsAppId,
      showActions: true,
      seenNotesAt,
      onMarkNoteSeen: markNoteSeen,
      pulsingIds,
      expandOverrides,
      courtHolds,
      onSetExpand: setExpandOverride
    };
    /* The toggle only controls court bucketing — both views render the same
       compact row, so a task looks identical either way. Flat view is the
       whole list in one CardList; grouped view splits it into court sections.
       Neither holds a Task Draft: those have their own tab (#363). */
    if (!grouped) {
      return <CardList tasks={list} emptyMessage={emptyMessage} now={now} {...cardProps} />;
    }
    const sections = buildCourtSections(list);
    if (sections.every((s) => s.tasks.length === 0)) {
      return <div className="empty-card">{emptyMessage}</div>;
    }
    return (
      <div className="courts">
        {sections.map((s) => s.tasks.length > 0 && (
          <section key={s.key} className="court" data-court={s.key}>
            <div className="section-head">
              <h2>
                {s.title}
                <span className="section-count">{s.tasks.length}</span>
              </h2>
            </div>
            <CardList tasks={s.tasks} emptyMessage="" now={now} {...cardProps} />
          </section>
        ))}
      </div>
    );
  };

  /* ── Metrics computations (admin only) ──────────────────── */
  const claimsLeaderboard = useMemo(() => {
    if (!isAdmin) return [];
    const counts = new Map<string, { id: string; displayName: string; count: number }>();
    for (const t of tasks) {
      if (!t.assignee) continue;
      const entry = counts.get(t.assignee.id);
      if (entry) {
        entry.count++;
      } else {
        counts.set(t.assignee.id, { id: t.assignee.id, displayName: t.assignee.displayName, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [tasks, isAdmin]);

  const statusTotals = useMemo(() => {
    if (!isAdmin) return { total: 0, active: 0, completed: 0, archived: 0, cancelled: 0 };
    let active = 0, completed = 0, archived = 0, cancelled = 0;
    for (const t of tasks) {
      if (t.status === "COMPLETED") completed++;
      else if (t.status === "ARCHIVED") archived++;
      else if (t.status === "CANCELLED") cancelled++;
      else active++;
    }
    return { total: tasks.length, active, completed, archived, cancelled };
  }, [tasks, isAdmin]);

  const typeBreakdown = useMemo(() => {
    if (!isAdmin) return [];
    const counts = new Map<TaskType, number>();
    for (const tt of TASK_TYPES) counts.set(tt, 0);
    for (const t of tasks) counts.set(t.taskType, (counts.get(t.taskType) ?? 0) + 1);
    const total = tasks.length || 1;
    return TASK_TYPES.map((tt) => ({
      type: tt,
      label: TASK_TYPE_LABELS[tt],
      count: counts.get(tt) ?? 0,
      pct: Math.round(((counts.get(tt) ?? 0) / total) * 100)
    }));
  }, [tasks, isAdmin]);

  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────── */}
      {/* Teams already shows "Hot Task" in its own tab, so no brand lockup
          here — that would be pure duplication. New Task lives on the list's
          own section header now (next to Grouped/Flat), so this top row is
          just nav (admin only) + the dev user picker — no need for it to
          read as its own heavy "bar" anymore. */}
      <header className="app-bar">
        {isAdmin && (
          <nav className="tab-bar">
            <button
              type="button"
              className={`tab-btn${activeTab === "active" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("active")}
            >
              Tasks
              <span className="section-count">{activeCount}</span>
            </button>
            <button
              type="button"
              className={`tab-btn${activeTab === "metrics" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("metrics")}
            >
              Metrics
            </button>
            <button
              type="button"
              className={`tab-btn${activeTab === "admin" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("admin")}
            >
              Admin
            </button>
          </nav>
        )}
        <div className="app-bar-actions">
          {IS_DEV ? (
            <label className="user-picker">
              <span>User:</span>
              {/* Disabled until the roster lands: with no people to offer there
                  is nothing to switch to, and the app is deliberately still
                  nobody at that point. `loadDevUsers` retries for a few seconds
                  first, so still-empty means the users file has nobody in it —
                  say the one command that fixes that rather than sitting on a
                  dead control. */}
              <select
                value={user.id}
                disabled={devUsers.length === 0}
                onChange={(e) => setUser(chooseDevUser(devUsers, e.target.value) ?? INITIAL_USER)}
              >
                {devUsers.length === 0 ? (
                  <option value="">No people — run npm run dev:reset</option>
                ) : (
                  devUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.roles.join("/")})
                    </option>
                  ))
                )}
              </select>
            </label>
          ) : (
            <span className="user-picker user-picker-static">{user.displayName}</span>
          )}
        </div>
      </header>

      {error && <p className="error-bar">{error}</p>}

      {/* New Task form (issue #72): its input state lives in the child, so
          typing never re-renders App or the task list. Mounted only while
          open; unmounting on close throws that state away — which is why the
          form asks before it calls `onClose` on anything a person has typed
          into (#283), and why it autosaves as it is typed so a reload or a
          closed tab can be picked back up (#284), on the server since #371.
          Both of those live in the child; App holds "is it open" and the
          autosave the form opens on, which the Task Drafts tab also lists. */}
      {formOpen && (
        <TaskForm
          key={reopened?.id ?? "new"}
          loans={loans}
          directory={directory}
          user={user}
          tasks={tasks}
          onClose={() => {
            setFormOpen(false);
            setReopened(null);
          }}
          onCreate={onCreate}
          onSaveForLater={onSaveForLater}
          onKeepUnsaved={onKeepUnsaved}
          onDiscardUnsaved={onDiscardUnsaved}
          onDeleteReopened={onDeleteReopened}
          onKeepAutosave={onKeepAutosave}
          onForgetAutosave={onForgetAutosave}
          {...(reopened ? { reopened } : { autosave })}
        />
      )}

      {/* The same form, opened on a task that already exists (#260). Mounted
          from App rather than from the card so it survives the list refresh a
          save triggers, and so the two modes are one component in one place.
          A task that vanished underneath the open form resolves to nothing and
          the form unmounts, rather than going on editing a snapshot. */}
      {editingTask && (
        <TaskForm
          loans={loans}
          directory={directory}
          user={user}
          tasks={tasks}
          onClose={() => setEditingTaskId(null)}
          onCreate={onCreate}
          edit={{
            task: editingTask,
            onSave: (edit) => onSaveEdit(editingTask, edit),
            /* The same function the server refuses with (#266), asked here so
               the form can shut the two boxes instead of letting someone type
               into them and be told no afterwards. Undefined for a party on an
               open task, which is the everyday case and leaves the pair exactly
               as #262 built them. */
            ...(editingLoanRefusal ? { loanRefusal: editingLoanRefusal } : {})
          }}
        />
      )}

      {/* ── Unified task grid ──────────────────────── */}
      {activeTab === "active" && (() => {
        /* A picked loan (#333) narrows All Tasks, so picking one opens that
           tab and remembers the tab it came from. A second pick while searching
           keeps the first remembered tab. The stored All / My value is left
           alone, so a reload mid-search opens on it. */
        const pickLoan = (loan: Loan): void => {
          if (!searchLoanId) setSearchReturnTab(boardTab);
          setSearchLoanId(loan.id);
          setBoardTab("all");
        };
        const clearSearch = (): void => {
          setSearchLoanId(null);
          selectBoardTab(searchReturnTab);
        };
        /* All Tasks, My Tasks, then Task Drafts (#363, #390). The tab row stands
           where the heading stood and is drawn whatever else is true, so no
           empty state or search can hide a tab. While searching, All Tasks
           carries the loan's name and `Clear search` sits beside the tabs while
           that tab is open. A draft is not a task, and the drafts page lists
           every one the viewer has. */
        const body = boardBody({ tab: boardTab, searching: Boolean(searchLoan), shownCount: boardTasks.length });
        return (
          <>
            <div className="section-head task-grid-head">
              <BoardTabs
                tab={boardTab}
                onTabChange={selectBoardTab}
                {...(searchLoan ? { allLabel: searchLoan.name, allTitle: searchLoan.name } : {})}
                allCount={allBoardTasks.length}
                mineCount={mineBoardTasks.length}
                draftsCount={taskDraftsCount(savedForLater, autosave, now)}
              />
              {boardTab === "all" && searchLoan && <LoanSearchStatus loan={searchLoan} onClear={clearSearch} />}
              <div className="task-grid-head-actions">
                {/* A search narrows All Tasks, so picking a loan opens it. */}
                <LoanSearch loans={loans} myLoanIds={searchMyLoanIds} onPick={pickLoan} />
                <AppMenu
                  grouped={grouped}
                  onGroupedChange={setGrouped}
                  history={boardHistory}
                  onHistoryChange={setBoardHistory}
                  expandedIds={boardTab === "drafts" ? [] : expandedIdsIn(boardTasks)}
                  onCollapseAll={collapseAllTasks}
                  themeChoice={themeChoice}
                  onThemeChange={setThemeChoice}
                />
                <NewTaskButton open={formOpen} onClick={() => { if (!formOpen) void openNewTask(); else { setFormOpen(false); setReopened(null); } }} />
              </div>
            </div>
            <div role="tabpanel" id={BOARD_PANEL_ID} aria-labelledby={boardTabId(boardTab)}>
              {body === "drafts" ? (
                <TaskDraftsPage items={savedForLater} autosave={autosave} now={now} onOpen={openSavedForLater} onDelete={deleteSavedForLater} onOpenAutosave={openNewTask} onDeleteAutosave={deleteAutosave} />
              ) : body === "search-empty" && searchLoan ? (
                <LoanSearchEmpty loan={searchLoan} onClear={clearSearch} />
              ) : body === "mine-empty" ? (
                <div className="empty-card">
                  Nothing of yours right now.{" "}
                  <button type="button" className="board-show-everyone" onClick={() => selectBoardTab("all")}>
                    Show all tasks
                  </button>
                </div>
              ) : (
                renderTaskList(boardTasks, "No tasks yet.")
              )}
            </div>
          </>
        );
      })()}

      {/* ── Metrics tab content ─────────────────────── */}
      {activeTab === "metrics" && isAdmin && (
        <MetricsPanel leaderboard={claimsLeaderboard} totals={statusTotals} typeBreakdown={typeBreakdown} />
      )}

      {/* ── Admin tab content ───────────────────────── */}
      {activeTab === "admin" && isAdmin && <AdminPanel user={user} />}

      {/* Last in the tree so it paints over everything, including the edit form,
          which is itself a modal (#265). */}
      {mergeAsk && (
        <MergeConfirmDialog
          collision={mergeAsk.collision}
          linkUntouched={mergeAsk.linkUntouched}
          busy={merging}
          onConfirm={() => mergeAsk.decide(true)}
          onCancel={() => mergeAsk.decide(false)}
        />
      )}
    </main>
  );
};
