import { app as teamsApp, authentication } from "@microsoft/teams-js";
import { ACTION_LABELS, CLOSED_STATUSES, ChecklistItem, CreateTaskInput, FraudCardAction, Loan, LoanTask, TaskHistoryEvent, TaskStatus, TaskType, TASK_TYPES, URGENCY_TIMEFRAMES, UrgencyLevel, UserIdentity, UserRole, byAttentionClaim, canAddNoteToTask, canApproveMerge, currentAssigneeSince, completedBy, archivedBy, canAssignTaskTo, canClaimTask, canCompleteTask, canMarkMergeDone, eligibleAssignees, canDeleteChecklistItem, canEditChecklist, canEditChecklistItemText, checklistSeat, ownChecklistNote, canRestoreTask, canReturnToPool, canTransitionStatus, canUnclaimTask, canUseCheckedPanel, canUseFixedPanel, NEEDS_FIXES_NOTE_REQUIRED, deriveMyLoanIds, formatWallDate, fraudCardActions, getNotesFieldLabel, handedOffAt, hasUnreadNoteForViewer, isConfirmingLook, isOverdue, inPoolSince, isUnclaimed, isUnclaimedTooLong, isTaskParty, standingTermsFor, unreadNoteFor, loanTypeaheadSuggestions, nextFlowStatuses, nextHighlightIndex, pendingPartyFor, readClaimIntent, restoreTargetStatus, sortChecklist, teamsTaskDeepLink, unresolvedCount, unresolvedForSubmit, parseHumperdinkPayload, humperdinkNoteText, readCreateFormIntent, URGENCY_LEVELS, canAmendTask } from "@loan-tasks/shared";
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, SelectHTMLAttributes } from "react";
import { placePanel, maxPanelHeight } from "./panel-placement";
import { createPortal } from "react-dom";
import { createTokenCache, sendWithToken } from "./auth-token";
import { CreateFormInitialValues, CreateFormValues, applyImportedLoan, initialCreateForm } from "./create-form-state";
import { ExpandOverrides, collapseTasks, expandedTaskIds, isTaskExpanded } from "./expand-state";
import { bylineOf, formatDate, initialsOf } from "./format";
import { TermsSection, ThreadMessages, threadHeadLabel } from "./thread";
import { Timeline } from "./timeline";
import { useToast } from "./toast";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const IS_DEV = import.meta.env.DEV;
/* Dev-only mock identities for the plain-browser path (no Teams host). The
   server's `x-user-*` header fallback (auth.ts, only when SSO is unconfigured)
   trusts these so local role-switching works. IS_DEV is statically false in a
   prod build, so this list and the selector are tree-shaken out of the bundle.
   In a Teams tab the real identity comes from the SSO token (bootstrap). */
const DEV_USERS: UserIdentity[] = [
  { id: "loan-officer-1", displayName: "Suzie", roles: ["LOAN_OFFICER"] },
  { id: "file-checker-1", displayName: "Alexa", roles: ["LOAN_OFFICER", "FILE_CHECKER"] },
  { id: "admin-1", displayName: "Johanna", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] }
];
const INITIAL_USER: UserIdentity = IS_DEV
  ? DEV_USERS[0]!
  : { id: "", displayName: "Signing in", roles: ["LOAN_OFFICER"] };

/* SSO bearer token. Module-level so the standalone apiRequest helper can read
   it without prop-drilling. The cache re-acquires expired tokens on its own —
   see auth-token.ts for why holding one is not enough (#175). */
const tokenCache = createTokenCache(() => authentication.getAuthToken());

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  LOI: "LOI Check",
  BUDDY_CHAT: "Buddy Chat",
  VALUE: "Value Check",
  FRAUD: "Fraud Check",
  LOAN_DOCS: "Loan Docs",
  OOO: "OOO - Out of Office"
};

const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  GREEN: "Within 24 Hours",
  YELLOW: "End of Day",
  ORANGE: "Within 1 Hour",
  RED: "Urgent Now"
};

/* The one urgency control in the app. The create form and the creator's amend
   panel (ADR-0006) render this same select — a second way to express timing is
   how the two drift apart, and neither surface offers a date at all: `dueAt` is
   derived from the band server-side (docs/product/due-date-urgency.md). The
   order is the shared `URGENCY_LEVELS`, least-to-most urgent, which is also the
   order the create form has always listed. */
const UrgencySelect = ({
  value,
  onChange,
  ariaLabel
}: {
  value: UrgencyLevel;
  onChange: (urgency: UrgencyLevel) => void;
  /* Only for a use outside a <label> — the create form has one wrapping it. */
  ariaLabel?: string;
}) => (
  <select
    {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    value={value}
    onChange={(e) => onChange(e.target.value as UrgencyLevel)}
  >
    {URGENCY_LEVELS.map((level) => (
      <option key={level} value={level}>{URGENCY_LABELS[level]}</option>
    ))}
  </select>
);

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

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed");
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

const applyTheme = (theme?: string): void => {
  const normalized = theme === "dark" || theme === "contrast" ? theme : "light";
  document.documentElement.setAttribute("data-theme", normalized);
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
  // added to the shared exclusion list reaches the badge and the red row stripe
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
type DirectoryUser = { id: string; displayName: string; roles: UserRole[] };

/* LOAN_DOCS and FRAUD have multiple stages between claim and complete. Stage
   suffix rides on the title as a hyphen suffix so the type label stays terse.
   For FRAUD it also disambiguates a released final-approval task sitting in the
   pool ("Final Approval Needed") from a fresh unclaimed check. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType === "LOAN_DOCS") {
    if (task.status === "MERGE_DONE") return " - Merge Done";
    if (task.status === "MERGE_APPROVED") return " - Merge Approved";
    return "";
  }
  if (task.taskType === "FRAUD") {
    if (task.status === "AWAITING_ITEMS") return " - Outstanding Items";
    if (task.status === "PENDING_APPROVAL") return task.assignee ? " - Final Approval" : " - Final Approval Needed";
    return "";
  }
  return "";
};

/* ── Poop score control ───────────────────────────────────── */
const PoopDisplay = ({
  count,
  canEdit,
  onChange
}: {
  count: number;
  canEdit: boolean;
  onChange: (next: number) => void;
}) => {
  const safeCount = Math.max(0, Math.min(5, count | 0));

  if (safeCount === 0 && !canEdit) return null;

  const titleText = canEdit
    ? `How Bad? ${safeCount}/5 — click to rate`
    : `How Bad? ${safeCount}/5`;

  return (
    <span
      className={`poop-track${canEdit ? " poop-track-editable" : ""}`}
      onClick={(e) => e.stopPropagation()}
      title={titleText}
      aria-label={titleText}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= safeCount;
        const className = `poop-slot${filled ? " poop-slot-on" : ""}`;
        if (!canEdit) {
          return (
            <span key={n} className={className} aria-hidden="true">
              💩
            </span>
          );
        }
        return (
          <button
            key={n}
            type="button"
            className={className}
            onClick={(e) => {
              e.stopPropagation();
              onChange(n === safeCount ? 0 : n);
            }}
            aria-label={`Set How Bad? to ${n}`}
            aria-pressed={filled}
          >
            💩
          </button>
        );
      })}
    </span>
  );
};

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

/* Funnel glyph for the per-row "filter to this loan" affordance (#57). Inline
   SVG in the ShareIcon idiom — no icon library ships. Sized via `.icon-filter`;
   color follows `currentColor`. */
const FilterIcon = () => (
  <svg
    className="icon-filter"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
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
   and was simply cut away. That overflow rule can't go (rounded corners, inset
   status stripe), so the panel leaves the clipping context instead. It now
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
   #122): `.task-card` keeps `overflow: hidden` for its rounded corners and
   inset stripe, so anything taller than a collapsed row has to leave the card.
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
/* Amending the ask (ADR-0006). Two calls, never one patch — the same shape the
   server's two routes have, so the surface can't offer a field the rule doesn't
   cover. There is no due-date member and there is no due-date input: `dueAt` is
   derived from the urgency band server-side. */
export interface AmendApi {
  setNotes: (taskId: string, notes: string) => Promise<void>;
  setUrgency: (taskId: string, urgency: UrgencyLevel) => Promise<void>;
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

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M3 8.5l3.2 3.3L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M3 4.5h10M6.5 4.5V3.2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.3M5 4.5l.6 8a1 1 0 0 0 1 .95h2.8a1 1 0 0 0 1-.95l.6-8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

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
  const open = unresolvedCount(items);
  /* The submit gate (#184), shown only to the person it gates and only while
     they hold the ball: every item wants a check, or a note saying why not.
     Who-and-when comes from the shared action set rather than being re-derived
     here — one answer to "may this viewer submit yet", the same one the card's
     button reads. `open` above is the softer count: an item the requester has
     explained is still open, but it no longer blocks the hand-back. */
  const submitBlocked = fraudCardActions(task, user).find((a) => a.targetStatus === "PENDING_APPROVAL")?.blockedReason;
  /* Which rows to point at, so the requester isn't hunting the list for them. */
  const blockingIds = new Set(submitBlocked ? unresolvedForSubmit(items).map((i) => i.id) : []);

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

  return (
    <div className="checklist">
      <div className="checklist-head">
        <span className="checklist-title">Outstanding items</span>
        <span className="checklist-count">{items.length === 0 ? "none yet" : `${open} open / ${items.length}`}</span>
        {submitBlocked && <span className="checklist-blocked">{submitBlocked}</span>}
      </div>

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
              <li key={item.id} className={`checklist-item${item.checked ? " checklist-item-done" : ""}${item.stale ? " checklist-item-stale" : ""}${blockingIds.has(item.id) ? " checklist-item-blocking" : ""}`}>
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

      {canRecord && (
        <div className="checklist-add">
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
  onAddCompletedNote,
  onUpdatePoints,
  amend,
  taskHistory,
  onFilterLoan,
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
  /* Append a note to an already-COMPLETED task (#45). Server keeps the task
     COMPLETED — no visible reopen. */
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  /* Amend the ask (ADR-0006) — offered to the creator of an active task only. */
  amend: AmendApi;
  /* Reading this task's history, for the menu's "Claimed" line (#166). Called
     on menu open, never on list load. */
  taskHistory: TaskHistoryApi;
  /* FRAUD structured checklist ops (#44). */
  checklist: ChecklistApi;
  onFilterLoan?: (loanId: string) => void;
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
  onSetExpand?: (taskId: string, open: boolean) => void;
  /* Ticking clock (ms) for the row's live countdown. */
  now?: number;
}) => {
  const [noteText, setNoteText] = useState("");
  /* FRAUD note-required moves (Send Outstanding Items / Send Back) reveal an
     inline textarea whose text posts as the transition's reviewNotes. `fraudNote`
     holds the draft; `openFraudNote` is the target status of the move whose box
     is open (null = none). The server also rejects a blank note. */
  const [fraudNote, setFraudNote] = useState("");
  const [openFraudNote, setOpenFraudNote] = useState<TaskStatus | null>(null);
  /* "Add a note" on a COMPLETED card (#45): the button reveals an inline field
     whose text posts to the server-atomic completed-note endpoint (task stays
     COMPLETED). `completedNoteOpen` toggles the field; `completedNote` is the
     draft. */
  const [completedNoteOpen, setCompletedNoteOpen] = useState(false);
  const [completedNote, setCompletedNote] = useState("");
  /* Amending the ask (ADR-0006, #160): the creator's in-place edit of the
     originating note and — on a non-OOO task — the urgency band. Opened from
     the thread head, because the thing it edits is the first entry in that
     thread; nothing new is added to the expanded body's section order. There is
     no draft here beyond the open panel: closing it discards. */
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendNotes, setAmendNotes] = useState("");
  const [amendUrgency, setAmendUrgency] = useState<UrgencyLevel>("GREEN");
  const [amendBusy, setAmendBusy] = useState(false);
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
  useEffect(() => {
    if (cancelStage !== "done") return;
    const id = setTimeout(() => setCancelStage("idle"), 1200);
    return () => clearTimeout(id);
  }, [cancelStage]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
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
  const setExpanded = (open: boolean): void => onSetExpand?.(task.id, open);
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
  /* The grouped ("courts") row is deliberately mono: the court section already
     says "whose court" and the row's own thin stripe encodes overdue, so we
     carry only the dim, mini, and celebrating-pulse signals — no colored status
     stripe, closed backdrop, or own/watching accents. */
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
  const urgencyTitle = task.taskType !== "OOO" ? `Urgency: ${URGENCY_LABELS[task.urgency]}` : undefined;

  /* FRAUD two-phase role-aware buttons (#39), shared with the bot cards so both
     surfaces show the same set. Empty for non-FRAUD. `fraudQuick` is the phase's
     one forward move, promoted to the collapsed quick-action slot; the leftovers
     (Send Back, Release) live in the expanded body. */
  const fraudActions = fraudCardActions(task, user);
  const fraudHasChecklist = (task.checklist?.length ?? 0) > 0;
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
     button a second time in the expanded body. When it's note-required and the
     checklist is empty the body still hosts its note box (see
     promotedNoteTarget); the button is what's deduped, not the composer. */
  const expandedFraudActions = fraudActions.filter((a) => a !== fraudQuick);
  /* A populated checklist already satisfies the server's "items or note" rule,
     so a promoted note-required move fires straight from the row; only an empty
     checklist still needs the note box gate (#84). */
  const promotedNoteTarget =
    fraudQuick && fraudQuick.kind === "transitionWithNote" && !fraudHasChecklist
      ? fraudQuick.targetStatus
      : undefined;
  /* `blockedReason` is set when the move is the phase's forward step but the
     task's state won't take it yet — today only Submit, held until every
     checklist item is checked or noted (#184). Same sentence the server's
     refusal would carry, so the button doesn't teach a different rule. */
  type QuickAction = { label: string; kind: "good" | "ghost" | "danger" | "default"; run: () => void; blockedReason?: string; blockedCount?: number };
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
      /* Note-required with an empty checklist: the row can't host a textarea, so
         the button opens the card and reveals the composer in the body rather
         than firing a move the server would reject. */
      const needsNote = promotedNoteTarget !== undefined;
      primaryAction = {
        label: fraudQuick.label,
        kind: "good",
        run: needsNote
          ? () => { setFraudNote(""); setExpanded(true); setOpenFraudNote(target); }
          : () => { void onTransition(task.id, target); },
        /* Both carried through under the names shared gives them — the count
           rides alongside the sentence rather than being recomputed here, so the
           narrow action column can't disagree with the tooltip beside it. */
        ...(fraudQuick.blockedReason
          ? { blockedReason: fraudQuick.blockedReason, blockedCount: fraudQuick.blockedCount ?? 0 }
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
        run: () => { void onTransition(task.id, "COMPLETED"); }
      };
    } else if (canApproveMerge(task, user)) {
      primaryAction = { label: ACTION_LABELS.APPROVE_MERGE, kind: "good", run: () => { void onTransition(task.id, "MERGE_APPROVED"); } };
    } else if (task.status === "MERGE_APPROVED" && canCompleteTask(task, user)) {
      primaryAction = { label: ACTION_LABELS.COMPLETE, kind: "good", run: () => { void onTransition(task.id, "COMPLETED"); } };
    } else if (task.status === "COMPLETED" && isCreator) {
      primaryAction = { label: ACTION_LABELS.ARCHIVE, kind: "ghost", run: () => { void onTransition(task.id, "ARCHIVED"); } };
    }
    /* Re-open is intentionally NOT a quick-action — it lives in the
       expanded body. Closed mini rows show Archive (creator-only) or
       nothing; clicking the row expands to reveal Re-open. */
  }
  // One button style for the row's primary action, regardless of kind —
  // plain filled-brand, matching every other button in this row (Send,
  // Add note, ...). Used to differentiate good/ghost/danger; that read as
  // three inconsistent button styles for what's always the row's one
  // next-step action.
  const quickActionClass = primaryAction ? "btn-sm task-card-quick-action" : "";

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
  const waitingLabel =
    !primaryAction && waitingOn && waitingOn.id !== user.id
      ? `Waiting on ${firstName(waitingOn.displayName)}`
      : null;
  /* `transitions` already carries the status's allowed moves, so CANCELLED
     being in it is the same rule the server enforces. */
  const showRowCancel =
    showActions && !primaryAction && !waitingLabel && isCreator && !isClosed && transitions.includes("CANCELLED");

  /* Expanded body, rendered below the collapsed row when open.
     Mirrors the design's accordion: a slim metadata strip up top, then a
     220px / 1fr split — Timeline + actions on the left, the conversation
     thread on the right. */
  const notesLabel = getNotesFieldLabel(task.taskType);
  const replyTarget = isCreator
    ? task.assignee ? firstName(task.assignee.displayName) : "the pool"
    : firstName(task.createdBy.displayName);
  const canPostNote =
    showActions &&
    !CLOSED_STATUSES.includes(task.status) &&
    canNoteTask;

  /* Fire a FRAUD move. Plain transition and release are one-tap; a note-required
     move (Send Outstanding Items / Send Back) posts the (optional) note as the
     transition's reviewNotes. With the structured checklist (#44) the note is
     optional context — a non-empty checklist is the payload — so the move sends
     even with an empty note as long as there are items. */
  const runFraudAction = (action: FraudCardAction): void => {
    acknowledgeUnread();
    if (action.kind === "release") {
      void onRelease(task.id);
    } else if ((action.kind === "transition" || action.kind === "transitionWithNote") && action.targetStatus) {
      // transitionWithNote only reaches here when the checklist already has
      // items (see noteRequired below), so it's safe to fire note-free.
      void onTransition(task.id, action.targetStatus);
    }
  };
  const submitFraudNote = (target: TaskStatus): void => {
    const note = fraudNote.trim();
    // The server rejects an empty hand-back with no note AND no checklist; the
    // button mirrors that so the checklist path sends note-free.
    if (!note && !fraudHasChecklist) return;
    acknowledgeUnread();
    void onTransition(task.id, target, note || undefined);
    setFraudNote("");
    setOpenFraudNote(null);
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

  /* The inline note a note-required move posts as its reviewNotes. Shared by
     the body's own buttons and by the move promoted to the collapsed row —
     the row can't host a textarea, so its button opens the card and reveals
     this composer here. */
  const fraudNoteBox = (target: TaskStatus) => (
    <div className="task-card-fraud-note">
      <textarea
        rows={2}
        placeholder={fraudHasChecklist ? "Optional note for the thread…" : "Describe what's outstanding…"}
        value={fraudNote}
        onChange={(e) => setFraudNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFraudNote(target); } }}
        autoFocus
      />
      <div className="task-card-fraud-note-actions">
        <button type="button" className="btn-sm btn-good" onClick={() => submitFraudNote(target)} disabled={!fraudNote.trim() && !fraudHasChecklist}>
          Send
        </button>
        <button type="button" className="btn-sm btn-ghost" onClick={() => { setOpenFraudNote(null); setFraudNote(""); }}>
          Cancel
        </button>
      </div>
    </div>
  );

  /* The expanded body carries no fraud *buttons*. The phase's forward move
     rides the collapsed row (fraudQuick) and the alternatives sit in the
     hamburger (fraudMenuActions) — a lone `Send Back` floating above the
     outstanding items read as part of the checklist rather than as the
     card's action. All that's left here is the composer the row's own
     note-required move opens, which has nowhere else to go: the row can't
     host a textarea. */
  const promotedNoteOpen = promotedNoteTarget !== undefined && openFraudNote === promotedNoteTarget;
  const fraudActionsBlock = showActions && cancelStage === "idle" && promotedNoteOpen && promotedNoteTarget && (
    <div className="task-card-fraud">{fraudNoteBox(promotedNoteTarget)}</div>
  );

  /* The alternatives to the phase's forward move (#39) — `Send Back`'s
     bounce and `Release`'s hand-off to the checker pool. Both are steps
     sideways or backwards, so they live in the menu next to `Send back to checker`
     and `Undo Merge Done` rather than in the body. Rendered inside the
     hamburger; the note box opens in place, which the panel already
     supports (its Esc handler exempts text fields). Same set the bot DM
     cards render. */
  const fraudMenuActions = expandedFraudActions.map((action) => {
    // A populated checklist already satisfies the server's
    // "items or note" rule, so a transitionWithNote action
    // fires immediately in that case — only an empty
    // checklist still needs the note box gate (#84).
    const noteRequired = action.kind === "transitionWithNote" && !fraudHasChecklist;
    const noteOpen = noteRequired && openFraudNote === action.targetStatus;
    return (
      <div key={action.label} className="task-card-fraud-action">
        <button
          type="button"
          className="btn-sm btn-ghost"
          aria-expanded={noteRequired ? noteOpen : undefined}
          onClick={() => {
            if (noteRequired && action.targetStatus) {
              setFraudNote("");
              setOpenFraudNote(noteOpen ? null : action.targetStatus);
            } else {
              runFraudAction(action);
            }
          }}
        >
          {action.label}
        </button>
        {noteOpen && action.targetStatus && fraudNoteBox(action.targetStatus)}
      </div>
    );
  });

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

  /* Whether the menu has anything worth opening. Written as "is any block
     non-empty" rather than a list of action checks, because the answer stopped
     being about actions when the timestamps moved in: a closed task and a task
     you have no seat on both have no actions at all, and they are the rows
     someone is most likely to open the menu on to check a date. Created always
     renders, so in practice the trigger is now on every row — this stays a
     computed answer rather than `true` so it follows the contents if a later
     change makes the block conditional. */
  const menuHasContent = [
    secondaryActionsBlock,
    shareMenuItemBlock,
    assignMenuItemBlock,
    cancelStage !== "idle",
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
          {secondaryActionsBlock}
          {shareMenuItemBlock}
          {assignMenuItemBlock}
          {menuTimestamps}
        </div>,
        document.body
      )}
    </span>
  );

  const checklistBlock = task.taskType === "FRAUD" && <FraudChecklist task={task} user={user} api={checklist} />;

  /* Amend the ask (ADR-0006). The shared predicate, not a local re-derivation:
     the server's two operations refuse through the same `amendRefusal`, so the
     button can't appear on a task the server would turn away. */
  const canAmend = canAmendTask(task, user);

  const openAmend = (): void => {
    setAmendNotes(task.notes ?? "");
    setAmendUrgency(task.urgency);
    setAmendOpen(true);
  };

  /* One Save for both fields, two calls behind it — the operations stay focused
     server-side and each is a no-op when its field didn't move, so an untouched
     urgency writes no history and DMs nobody. Notes go first: if the urgency
     call is refused, the correction the creator most likely came for is already
     saved. A refusal rejects (the api layer toasts and rethrows) and the panel
     stays open with the draft intact — closing it would take both. */
  const submitAmend = async (): Promise<void> => {
    const nextNotes = amendNotes.trim();
    if (!nextNotes) return;
    setAmendBusy(true);
    try {
      if (nextNotes !== (task.notes ?? "")) {
        await amend.setNotes(task.id, nextNotes);
      }
      if (task.taskType !== "OOO" && amendUrgency !== task.urgency) {
        await amend.setUrgency(task.id, amendUrgency);
      }
      setAmendOpen(false);
    } catch {
      // Toasted at the api layer; nothing to add, and the panel holds its draft.
    } finally {
      setAmendBusy(false);
    }
  };

  /* Editing the originating note in place, where it is displayed, rather than
     as a new section in the expanded body. No due-date input, on purpose: the
     product expresses timing as a band and derives the deadline from it, so a
     date picker here would be a control the app has nowhere else and would let
     the two disagree. OOO has no urgency row at all — its timing is its start
     and return dates, which this operation deliberately does not touch. */
  const amendBlock = (
    <div className="composer" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <textarea
        rows={3}
        aria-label={`Edit ${notesLabel.toLowerCase()}`}
        value={amendNotes}
        onChange={(e) => setAmendNotes(e.target.value)}
      />
      {task.taskType !== "OOO" && (
        <label>
          Urgency
          <UrgencySelect value={amendUrgency} onChange={setAmendUrgency} />
        </label>
      )}
      <span>
        <button
          type="button"
          className="btn-sm"
          onClick={() => { void submitAmend(); }}
          disabled={amendBusy || !amendNotes.trim()}
        >
          Save
        </button>
        <button type="button" className="btn-sm btn-ghost" onClick={() => setAmendOpen(false)} disabled={amendBusy}>
          Cancel
        </button>
      </span>
    </div>
  );

  /* Where the task's own field is drawn, and where it isn't (ADR-0008 rules 1
     and 2). `standingTermsFor` decides once: on an LOI it hands back the terms,
     the `TermsSection` above the thread draws them, and `ThreadMessages` leaves
     the conversation to the replies. On the other five it hands back nothing,
     the section renders nothing, and the field opens the thread as before.

     The amend button rides whichever of the two the field is in. It is still
     the one door and still the same handler — ADR-0008 rule 4 replaces it with
     `Edit Task` in the hamburger (#260) — but until then it has to sit with the
     field it edits, not over a conversation it does not write to. */
  const standingTerms = standingTermsFor(task);
  const amendButton = canAmend && !amendOpen && (
    <button type="button" className="btn-sm btn-ghost" onClick={openAmend}>
      Edit request
    </button>
  );
  const termsBlock = standingTerms === undefined ? null : (
    <div className="task-card-terms">
      <TermsSection task={task} action={amendButton} />
      {amendOpen && amendBlock}
    </div>
  );
  const notesBlock = (
    <>
      <div className="thread-head">
        {threadHeadLabel(task)}
        {standingTerms === undefined && amendButton}
      </div>
      {standingTerms === undefined && amendOpen && amendBlock}
      <div className="msgs" ref={reviewListRef}>
        <ThreadMessages task={task} viewerId={user.id} />
      </div>
      {canPostNote && (
        <div className="composer">
          <textarea
            rows={1}
            placeholder={`Reply to ${replyTarget}…`}
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
  const renderExpanded = () => (
    <div className="task-card-expanded">
      <Timeline task={task} />
      {fraudActionsBlock}
      {checklistBlock && <div className="task-card-checklist">{checklistBlock}</div>}
      {termsBlock}
      <div className="thread">{notesBlock}</div>
    </div>
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
        <span className="task-card-grouped-stripe" aria-hidden="true" />
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
          <span className={`task-card-collapsed-type task-type-${task.taskType.toLowerCase()}`}>
            {TASK_TYPE_LABELS[task.taskType]}
            {stageSuffix(task) && <span className="task-card-collapsed-stage">{stageSuffix(task)}</span>}
            {!mini && (
              <PoopDisplay
                count={task.points ?? 0}
                canEdit={isCreator && !isClosed}
                onChange={(n) => { void onUpdatePoints(task.id, n); }}
              />
            )}
            {hasUnreadNote && (
              <span className="task-card-unread-dot" aria-label="New note" title="New note" />
            )}
          </span>
          <span className="task-card-collapsed-folder">
            {task.taskType !== "OOO" && task.humperdinkLink ? (
              // The loan name opens the Humperdink link directly (#57); the
              // ↗ marks it as an external link.
              <a href={task.humperdinkLink} target="_blank" rel="noreferrer" aria-label={`Open Humperdink link for ${task.folderName}`} title="Open Humperdink link" onClick={stopBubble}>
                <span className="task-card-collapsed-folder-name">{task.folderName}</span>
                <span className="external-link-icon" aria-hidden="true">↗</span>
              </a>
            ) : (
              // No stored link → the name is inert plain text (#57).
              <span>{task.folderName}</span>
            )}
            {task.taskType !== "OOO" && task.loanId && onFilterLoan && (
              <button
                type="button"
                className="loan-filter-btn"
                aria-label={`Filter list to loan: ${task.folderName}`}
                title={`Filter to loan: ${task.folderName}`}
                onClick={(e) => { stopBubble(e); onFilterLoan(task.loanId!); }}
              >
                <FilterIcon />
              </button>
            )}
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
                onClick={(e) => { e.stopPropagation(); acknowledgeUnread(); primaryAction!.run(); }}
              >
                {primaryAction.label}
              </button>
              {/* The column is one button wide, so the slot shows the count and
                  the full sentence rides the title, the button's aria-label and
                  the expanded checklist head — next to the rows it names. */}
              {primaryAction.blockedReason && (
                <span className="task-card-quick-action-blocked">{`${primaryAction.blockedCount} to resolve`}</span>
              )}
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
  onAddCompletedNote,
  onUpdatePoints,
  amend,
  taskHistory,
  onFilterLoan,
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
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  amend: AmendApi;
  taskHistory: TaskHistoryApi;
  onFilterLoan?: (loanId: string) => void;
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
  onSetExpand?: (taskId: string, open: boolean) => void;
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
          onAddCompletedNote={onAddCompletedNote}
          onUpdatePoints={onUpdatePoints}
          amend={amend}
          taskHistory={taskHistory}
          {...(onFilterLoan ? { onFilterLoan } : {})}
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
          {...(onSetExpand ? { onSetExpand } : {})}
        />
      ))
    )}
  </div>
);

/* Grouped/Flat list-view segment (#106 follow-up): lives on the list's own
   section header, where it actually describes what it changes, rather than
   floating in the top app bar. */
const GroupSeg = ({ grouped, onChange }: { grouped: boolean; onChange: (g: boolean) => void }) => (
  <div className="seg" role="group" aria-label="List grouping">
    <button type="button" className={grouped ? "seg-on" : ""} aria-pressed={grouped} onClick={() => onChange(true)}>
      Grouped
    </button>
    <button type="button" className={!grouped ? "seg-on" : ""} aria-pressed={!grouped} onClick={() => onChange(false)}>
      Flat
    </button>
  </div>
);

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

/* Collapse all (#177): closes every card currently expanded *in this list*,
   in one press. The caller passes the ids its own list renders, so the tab /
   loan-filter / grouping scoping is already done and cards the viewer can't
   see are never touched.

   One-way by design. An Expand all would write an open entry for every card
   the viewer never touched — the list rearranging itself under them, which is
   exactly what #161 took out, only self-inflicted. Collapsing is different:
   it restores the grid's resting state, which is where every card starts.

   Inert rather than hidden when nothing below is open, so the header's
   controls don't shuffle as cards open and close — and `aria-disabled` rather
   than `disabled`, so the button keeps its place in the tab order and a screen
   reader user can land on it and hear that there is nothing here to collapse.

   `scope` names the list, because the visible label can't: three headers
   render the same two words, and under a loan filter the button closes that
   loan's cards only. */
const CollapseAllButton = ({
  expandedIds,
  scope,
  onCollapse
}: {
  expandedIds: string[];
  scope: string;
  onCollapse: (taskIds: string[]) => void;
}) => {
  const count = expandedIds.length;
  return (
    <button
      type="button"
      className="btn-sm btn-ghost collapse-all"
      aria-disabled={count === 0}
      aria-label={
        count === 0
          ? `Collapse all expanded tasks in ${scope} — nothing is expanded`
          : `Collapse all ${count} expanded task${count === 1 ? "" : "s"} in ${scope}`
      }
      onClick={() => {
        if (count === 0) return;
        onCollapse(expandedIds);
      }}
    >
      Collapse all
    </button>
  );
};

/* Editable header shown above the task list when it's filtered to a single
   Loan (ADR-0001). The app's only post-creation edit surface, scoped to the
   Loan's name + Humperdink link. Any authenticated user may edit. */
const LoanFilterHeader = ({
  loan,
  taskCount,
  onSave,
  onClear,
  grouped,
  onGroupedChange,
  formOpen,
  onToggleForm,
  expandedIds,
  onCollapseAll
}: {
  loan: Loan;
  taskCount: number;
  onSave: (loanId: string, name: string, humperdinkLink: string) => Promise<void>;
  onClear: () => void;
  grouped: boolean;
  onGroupedChange: (g: boolean) => void;
  formOpen: boolean;
  onToggleForm: () => void;
  expandedIds: string[];
  onCollapseAll: (taskIds: string[]) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(loan.name);
  const [link, setLink] = useState(loan.humperdinkLink ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // Re-sync when the underlying loan changes (e.g. after a save/merge).
    setName(loan.name);
    setLink(loan.humperdinkLink ?? "");
    setEditing(false);
  }, [loan.id, loan.name, loan.humperdinkLink]);

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(loan.id, name, link);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="loan-header">
      <div className="loan-header-main">
        <span className="loan-header-eyebrow">Loan</span>
        {editing ? (
          <div className="loan-header-edit">
            <input
              className="loan-header-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Loan name"
            />
            <input
              className="loan-header-link-input"
              value={link}
              placeholder="Humperdink link (optional)"
              onChange={(e) => setLink(e.target.value)}
              aria-label="Humperdink link"
            />
            <button type="button" className="btn-sm btn-good" disabled={saving} onClick={() => { void save(); }}>Save</button>
            <button type="button" className="btn-sm btn-ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <div className="loan-header-view">
            <h2 className="loan-header-name">{loan.name}</h2>
            {loan.humperdinkLink && (
              <a className="loan-header-link" href={loan.humperdinkLink} target="_blank" rel="noreferrer">
                Humperdink <span aria-hidden="true">↗</span>
              </a>
            )}
            <button type="button" className="btn-sm btn-ghost" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </div>
      <div className="loan-header-meta">
        <span className="section-count">{taskCount} TASK{taskCount === 1 ? "" : "S"}</span>
        <GroupSeg grouped={grouped} onChange={onGroupedChange} />
        <CollapseAllButton expandedIds={expandedIds} scope={loan.name} onCollapse={onCollapseAll} />
        <NewTaskButton open={formOpen} onClick={onToggleForm} />
        <button type="button" className="btn-sm btn-ghost" onClick={onClear}>Clear filter</button>
      </div>
    </div>
  );
};

/* ── Metrics Panel ────────────────────────────────────────── */
const TYPE_BAR_CLASS: Record<TaskType, string> = {
  LOI: "type-bar type-bar-brand",
  BUDDY_CHAT: "type-bar type-bar-brand",
  VALUE: "type-bar type-bar-good",
  FRAUD: "type-bar type-bar-bad",
  LOAN_DOCS: "type-bar type-bar-hot",
  OOO: "type-bar type-bar-brand"
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
          <div className="stat-card stat-card-total">
            <div className="stat-number">{totals.total}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card stat-card-active">
            <div className="stat-number">{totals.active}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card stat-card-completed">
            <div className="stat-number">{totals.completed}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card stat-card-archived">
            <div className="stat-number">{totals.archived}</div>
            <div className="stat-label">Archived</div>
          </div>
          <div className="stat-card stat-card-cancelled">
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

const formatAgo = (iso?: string): string => {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(diff / 3600000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diff / 86400000);
  return `${day}d ago`;
};

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

/* ── Create-task form ─────────────────────────────────────────
   Extracted from App (issue #72) so that typing in any field only
   re-renders this subtree — App (and the whole task list it renders) no
   longer re-renders on every keystroke. All form-input state lives here;
   App keeps only `formOpen` and mounts this child while it's true. The two
   side-effects the form triggers (persist + post-create share) stay on App
   behind the single stable `onCreate` callback so this component stays
   presentational — it builds the payload and closes on success. */
interface CreateTaskFormProps {
  loans: Loan[];
  directory: DirectoryUser[];
  user: UserIdentity;
  tasks: LoanTask[];
  onClose: () => void;
  /* Persist the task, then fire the optional post-create share (#46) with its
     delivered/couldn't-reach toast, and refresh. Resolves once the task is
     created; rejects only when the create itself fails (App has already shown
     the error toast) so the form stays open for a retry. */
  onCreate: (payload: CreateTaskInput, shareWithUserId: string, note?: string) => Promise<void>;
  /* Values the form opens with (#194). Omitted — the everyday case — opens it
     blank, exactly as before. The defaults and the FRAUD seeder / recipient
     picker / OOO date fields all live in `create-form-state.ts`; see there for
     why only this subset is openable. */
  initialValues?: CreateFormInitialValues;
}

const CreateTaskForm = ({ loans, directory, user, tasks, onClose, onCreate, initialValues }: CreateTaskFormProps) => {
  const { showToast } = useToast();
  /* Lazy initializer, so re-renders don't rebuild the state and a changing
     `initialValues` identity can't reset a half-typed draft: the values seed
     the form once, at open. Reopening the form remounts this component, which
     is when new initial values take effect. */
  const [form, setForm] = useState<CreateFormValues>(() => initialCreateForm(initialValues));
  /* Draft text for the FRAUD outstanding-items seeder input (#69), separate
     from the committed `form.initialItems` list. */
  const [seedDraft, setSeedDraft] = useState("");
  /* Create-form loan typeahead: which suggestion list is open + which loan
     (if any) the typed Folder Name resolved to. */
  const [loanSuggestOpen, setLoanSuggestOpen] = useState(false);
  /* The text the user actually typed into Folder Name (issue #55). Kept
     separate from `form.folderName` so keyboard arrow-autofill can preview a
     highlighted loan's name in the field without reshuffling the match list. */
  const [loanQuery, setLoanQuery] = useState("");
  /* Highlighted suggestion index for keyboard nav, or -1 for none (#55). */
  const [loanHighlight, setLoanHighlight] = useState(-1);
  const [namvarHover, setNamvarHover] = useState<number | null>(null);
  /* In-flight guard for Create (#115). Not a debounce — the reported double
     submit came from a deliberate second click after a pause, so the flag is
     held for the WHOLE operation (create + the post-create share `onCreate`
     also awaits) and released only when it settles. It doubles as the button's
     pending state, which is half the fix: the reporter's read was "the button
     didn't register my click," and a disabled `Creating…` corrects that. */
  const [submitting, setSubmitting] = useState(false);
  /* Humperdink import (#194). `importText` is the paste target — the human
     presses paste, the app never reads the clipboard itself. `imported` is the
     button's own confirmation, cleared the moment the text changes so the label
     can't claim a paste it hasn't taken. */
  const [importText, setImportText] = useState("");
  const [imported, setImported] = useState(false);
  /* The note text the last import wrote (#196), so a second import replaces its
     own block rather than stacking a second copy of the terms under the first.
     Whatever the filer typed around it is theirs and survives either way. */
  const [importedNote, setImportedNote] = useState("");

  /* Take a pasted Humperdink payload into the form, or say why it can't.
     A failure leaves every field exactly as it was: the parser returns a reason
     rather than a null so the filer, who has no console open, gets told. */
  const importFromHumperdink = (): void => {
    const result = parseHumperdinkPayload(importText);
    if (!result.ok) {
      setImported(false);
      showToast(result.error, { variant: "error" });
      return;
    }
    const noteText = humperdinkNoteText(result.payload);
    setForm((c) => applyImportedLoan(c, result.payload, { noteText, previousNoteText: importedNote }));
    setImportedNote(noteText);
    // Keep the typeahead in step with the name the import just wrote, and shut
    // it — the loan is settled, so a suggestion list over it is only noise.
    setLoanQuery(result.payload.loanName);
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    setImported(true);
  };

  /* Loans that are "mine" for the create-form shortlist (#55): any loan linked
     by a task the current user created (merged loans share one id, so they
     count automatically). Drives the empty-query, open-on-focus view. Kept
     local so it only recomputes on this form's renders, not App's. */
  const myLoanIds = useMemo(() => deriveMyLoanIds(tasks, user.id), [tasks, user.id]);

  /* Current typeahead suggestions: empty query → my most-recently-used loans;
     typing → all users' loans ranked by match (#55). Excludes an option that
     exactly equals what's already typed. */
  const loanMatches = useMemo(
    () =>
      loanTypeaheadSuggestions(loanQuery, loans, myLoanIds, 6).filter(
        (m) => m.loan.name.trim().toLowerCase() !== loanQuery.trim().toLowerCase()
      ),
    [loanQuery, loans, myLoanIds]
  );

  /* Commit a loan pick from the typeahead (mouse click or keyboard Enter):
     link the task to the existing loan and confirm with a transient toast
     (#56) instead of an inline hint that reflowed the form. */
  const selectLoan = (loan: Loan): void => {
    setForm((c) => ({
      ...c,
      folderName: loan.name,
      loanId: loan.id,
      humperdinkLink: loan.humperdinkLink ?? c.humperdinkLink
    }));
    setLoanQuery(loan.name);
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    showToast("Linked to an existing loan", { variant: "success" });
  };

  /* Everyone who could work this task if it existed — the shared predicate, so
     the form, the row and the server all agree on who that is. Excludes the
     filer themselves: a task born assigned to its own creator is the fourth
     door ADR-0003 shuts. */
  const eligible = useMemo(
    () => eligibleAssignees({ taskType: form.taskType, createdBy: { id: user.id, displayName: user.displayName } }, directory),
    [directory, form.taskType, user.id, user.displayName]
  );

  /* Who the one at-creation picker offers, per mode. Assign offers only people
     who could actually take it; Share excludes just you, since you already know
     about your own task. */
  const recipientCandidates = useMemo(
    () => (form.pickerMode === "assign" ? eligible : directory.filter((u) => u.id !== user.id)),
    [directory, eligible, form.pickerMode, user.id]
  );

  /* The sole-checker dead end (#142). If the only file checker available is the
     person filing, nobody can claim this Fraud Check — the creator is barred
     from their own task at every door, with no admin override and no escape
     hatch, because an escape hatch is indistinguishable from letting one person
     file and check their own review. So the form says so up front and the filer
     redirects it, instead of the task sitting unclaimable with no error that
     helps. It informs; it never blocks submit. `directory.length > 0` keeps a
     not-yet-loaded directory from crying wolf. */
  const noEligibleChecker = form.taskType === "FRAUD" && directory.length > 0 && eligible.length === 0;
  /* Two ways to reach that dead end, and they aren't the same sentence. If the
     filer holds FILE_CHECKER, the only checker around is them and the rule
     that bites is second-pair-of-hands. If they don't, there simply is no
     checker to hand it to. */
  const noCheckerWarning = user.roles.includes("FILE_CHECKER")
    ? "You're the only file checker available, and nobody can work a Fraud Check they filed themselves — so no one will be able to claim this one. Someone else needs to file it."
    : "No file checker is available to work this Fraud Check, so nobody will be able to claim it. Worth checking who's on shift before you file.";

  /* Switching to Assign, or to a Fraud Check, can make the current pick
     ineligible. Drop it rather than leave a selection showing that the server
     would reject at submit. */
  useEffect(() => {
    if (form.recipientUserId && !recipientCandidates.some((c) => c.id === form.recipientUserId)) {
      setForm((c) => ({ ...c, recipientUserId: "" }));
    }
  }, [recipientCandidates, form.recipientUserId]);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // Re-entry guard (#115). Covers every submit path, not just the button:
    // Enter in a text field and held/repeated Enter both land here.
    if (submitting) return;
    const rawLink = form.humperdinkLink.trim();
    const normalizedLink = rawLink && !/^https?:\/\//i.test(rawLink) ? `https://${rawLink}` : rawLink;
    // Only pass loanId when the typed name still matches the selected loan —
    // editing the text after selecting means the user intends a new loan.
    const selectedLoan = form.loanId ? loans.find((l) => l.id === form.loanId) : undefined;
    const keepLoanId = form.taskType !== "OOO" && selectedLoan && selectedLoan.name === form.folderName.trim();
    // FRAUD only (#69): fold any not-yet-added seeder draft into the list, then
    // ship the outstanding items the creator already knows about.
    const assignAtCreate = Boolean(form.recipientUserId) && form.pickerMode === "assign";
    const seededItems =
      form.taskType === "FRAUD"
        ? [...form.initialItems, seedDraft.trim()].map((t) => t.trim()).filter((t) => t.length > 0)
        : [];
    const payload: CreateTaskInput = {
      folderName: form.folderName,
      taskType: form.taskType,
      notes: form.notes,
      ...(keepLoanId ? { loanId: form.loanId } : {}),
      ...(form.taskType === "OOO" ? { startDate: form.startDate, returnDate: form.returnDate } : { urgency: form.urgency }),
      ...(form.taskType !== "OOO" && normalizedLink ? { humperdinkLink: normalizedLink } : {}),
      ...(form.points > 0 ? { points: form.points } : {}),
      ...(seededItems.length > 0 ? { initialItems: seededItems.map((text) => ({ text })) } : {}),
      // The two branches are deliberately asymmetric. A handoff rides the create
      // payload so the task is born assigned in ONE call — creating it first and
      // assigning after would post a claimable channel card and then edit the
      // Claim button away, and would race the backgrounded fan-out. A share
      // stays a follow-up call (below) because its response carries the
      // `delivered` reachability flag, which the create response has no place
      // to hold.
      ...(assignAtCreate ? { assigneeUserId: form.recipientUserId } : {}),
      ...(assignAtCreate && form.recipientNote.trim() ? { assigneeNote: form.recipientNote.trim() } : {})
    };

    setSubmitting(true);
    try {
      // App owns persist + post-create share + refresh; on success we close,
      // which unmounts this child and discards the draft state. A create
      // failure rejects here (App already toasted) — keep the form open.
      // onCreate deliberately resolves only after the share follow-up too, so
      // the pending state spans the whole wait rather than going idle-looking
      // mid-flight.
      await onCreate(
        payload,
        assignAtCreate ? "" : form.recipientUserId,
        form.recipientNote.trim() || undefined
      );
      onClose();
    } catch {
      /* create failed — App surfaced the error; leave the form open to retry */
    } finally {
      // In `finally`, not the catch: an exception must never strand the form
      // permanently disabled. Harmless after onClose — React no-ops a setState
      // on an unmounted component.
      setSubmitting(false);
    }
  };

  return (
    /* The backdrop is deliberately inert (#114): a stray click here used to
       call onClose, which unmounts this component and silently destroys the
       whole draft. Cancel and Escape are the only exits, and both are
       deliberate acts taken at the user's word — no confirmation prompt, no
       dirty tracking. The panel's old stopPropagation went with it; with
       nothing listening on the overlay it was dead weight. */
    <div
      className="form-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="form-panel">
      <form className="task-form" onSubmit={handleSubmit}>
        {/* Humperdink import (#194). Above Folder Name because it fills Folder
            Name — the shortcut sits where the typing it saves would start.
            Hidden for OOO: a vacation has no loan and no Humperdink link. */}
        {form.taskType !== "OOO" && (
          <div className="span-full task-form-import">
            <label className="task-form-import-field">
              Paste from Humperdink
              <input
                type="text"
                autoComplete="off"
                placeholder="Paste what Send to Hot Task copied"
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setImported(false);
                }}
                onKeyDown={(e) => {
                  // Enter in this field means "import", not "create the task" —
                  // the form's implicit submit would file a half-filled task
                  // out from under a paste.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    importFromHumperdink();
                  }
                }}
              />
            </label>
            <button type="button" className="btn-ghost btn-sm" onClick={importFromHumperdink}>
              {imported ? "Imported" : "Import from Humperdink"}
            </button>
          </div>
        )}
        <label>
          {form.taskType === "OOO" ? "Vacation Description" : "Folder Name"}
          {form.taskType === "OOO" ? (
            <input value={form.folderName} onChange={(e) => setForm((c) => ({ ...c, folderName: e.target.value }))} required />
          ) : (
            <span className="loan-typeahead">
              <input
                value={form.folderName}
                autoComplete="off"
                placeholder="Search existing loans or type a new name"
                role="combobox"
                aria-expanded={loanSuggestOpen && loanMatches.length > 0}
                aria-autocomplete="list"
                aria-activedescendant={loanHighlight >= 0 ? `loan-opt-${loanHighlight}` : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  // Typing diverges from any prior selection → treat as a new
                  // loan, and re-scope the match list to the typed query.
                  setForm((c) => ({ ...c, folderName: v, loanId: "" }));
                  setLoanQuery(v);
                  setLoanSuggestOpen(true);
                  setLoanHighlight(-1);
                }}
                onFocus={() => { setLoanQuery(form.folderName); setLoanSuggestOpen(true); setLoanHighlight(-1); }}
                onBlur={() => { window.setTimeout(() => setLoanSuggestOpen(false), 120); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    if (loanMatches.length === 0) return;
                    e.preventDefault();
                    if (!loanSuggestOpen) setLoanSuggestOpen(true);
                    const next = nextHighlightIndex(loanHighlight, e.key === "ArrowDown" ? 1 : -1, loanMatches.length);
                    setLoanHighlight(next);
                    // Autofill the field with the highlighted loan's name;
                    // selection (link + toast) waits for Enter.
                    const preview = loanMatches[next];
                    if (preview) setForm((c) => ({ ...c, folderName: preview.loan.name, loanId: "" }));
                  } else if (e.key === "Enter" && loanSuggestOpen && loanHighlight >= 0 && loanMatches[loanHighlight]) {
                    e.preventDefault();
                    selectLoan(loanMatches[loanHighlight]!.loan);
                  } else if (e.key === "Escape" && loanSuggestOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    setLoanSuggestOpen(false);
                    setLoanHighlight(-1);
                  }
                }}
                required
              />
              {loanSuggestOpen && loanMatches.length > 0 && (
                <ul className="loan-typeahead-list" role="listbox">
                  {loanMatches.map((m, i) => (
                    <li key={m.loan.id}>
                      <button
                        type="button"
                        id={`loan-opt-${i}`}
                        role="option"
                        aria-selected={i === loanHighlight}
                        className={`loan-typeahead-option${i === loanHighlight ? " loan-typeahead-option-active" : ""}`}
                        onMouseEnter={() => setLoanHighlight(i)}
                        // onMouseDown fires before the input's onBlur so the pick registers.
                        onMouseDown={(e) => { e.preventDefault(); selectLoan(m.loan); }}
                      >
                        <span className="loan-typeahead-name">{m.loan.name}</span>
                        {m.loan.humperdinkLink && <span className="loan-typeahead-link" aria-hidden="true">↗</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </span>
          )}
        </label>
        <label>
          Type
          <select value={form.taskType} onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}>
            <option value="LOI">LOI Check</option>
            <option value="BUDDY_CHAT">Buddy Chat</option>
            <option value="VALUE">Value Check</option>
            <option value="FRAUD">Fraud Check</option>
            <option value="LOAN_DOCS">Loan Docs</option>
            <option value="OOO">OOO - Out of Office</option>
          </select>
        </label>
        {form.taskType === "OOO" ? (
          <>
            <label>
              Start Date
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((c) => ({ ...c, startDate: e.target.value }))}
                required
              />
            </label>
            <label>
              Return Date
              <input
                type="date"
                value={form.returnDate}
                min={form.startDate || undefined}
                onChange={(e) => setForm((c) => ({ ...c, returnDate: e.target.value }))}
                required
              />
            </label>
          </>
        ) : (
          <label>
            Urgency
            <UrgencySelect value={form.urgency} onChange={(urgency) => setForm((c) => ({ ...c, urgency }))} />
          </label>
        )}
        <label>
          How Bad?
          <span
            className="poop-picker poop-picker-form"
            onMouseLeave={() => setNamvarHover(null)}
          >
            {[1, 2, 3, 4, 5].map((n) => {
              const active = n <= (namvarHover ?? form.points);
              return (
                <button
                  key={n}
                  type="button"
                  className={`poop-pick${active ? " poop-pick-on" : ""}`}
                  onMouseEnter={() => setNamvarHover(n)}
                  onClick={() => setForm((c) => ({ ...c, points: c.points === n ? 0 : n }))}
                  aria-label={`${n} poop${n === 1 ? "" : "s"}`}
                  aria-pressed={n <= form.points}
                >
                  💩
                </button>
              );
            })}
          </span>
        </label>
        {/* Two nodes for one sentence, on purpose. A live region only announces
            changes made INSIDE it, so one that appears with its text already in
            place is usually read out by nobody — and this warning is the whole
            signal a screen-reader user gets before the dead end. The region is
            always mounted (visually hidden, costing no layout) and only its
            text changes; the visible box is the sighted half, hidden from the
            reader so it isn't said twice. */}
        <p className="sr-only" role="status">{noEligibleChecker ? noCheckerWarning : ""}</p>
        {noEligibleChecker && (
          <p className="span-full task-form-warning" aria-hidden="true">{noCheckerWarning}</p>
        )}
        {/* FRAUD only (#69): seed the outstanding-items checklist with items
            the creator already knows about. Enter-to-add, mirrors the card's
            FraudChecklist add idiom. Optional — the checker seeds later.
            Rendered above Notes (#78) so the checklist leads the form. */}
        {form.taskType === "FRAUD" && (
          <div className="span-full task-form-seed">
            <span className="task-form-seed-head">Outstanding Items <span className="form-label-optional">- Optional</span></span>
            {form.initialItems.length > 0 && (
              <ul className="task-form-seed-list">
                {form.initialItems.map((text, idx) => (
                  <li key={idx} className="task-form-seed-item">
                    <span className="task-form-seed-text">{text}</span>
                    <button
                      type="button"
                      className="checklist-delete"
                      aria-label={`Remove "${text}"`}
                      onClick={() => setForm((c) => ({ ...c, initialItems: c.initialItems.filter((_, i) => i !== idx) }))}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* (#79) .checklist-add's dashed top divider exists to separate an
                already-seeded item list above it; with nothing seeded yet on
                the create form it reads as a stray gap, so drop it via
                .checklist-add-flush until the first item lands. */}
            <div className={`checklist-add${form.initialItems.length > 0 ? "" : " checklist-add-flush"}`}>
              <input
                className="checklist-item-input"
                placeholder="Add an item, press Enter…"
                value={seedDraft}
                onChange={(e) => setSeedDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = seedDraft.trim();
                    if (!v) return;
                    setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                    setSeedDraft("");
                  }
                }}
              />
              <button
                type="button"
                className="btn-sm"
                disabled={!seedDraft.trim()}
                onClick={() => {
                  const v = seedDraft.trim();
                  if (!v) return;
                  setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                  setSeedDraft("");
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}
        <label className="span-full">
          {/* FRAUD's free-text field is now a general discussion seed, so it
              gets a purpose-built "Notes" label (#69); the shared
              NOTES_FIELD_LABELS.FRAUD ("Discussion") heads the card thread. */}
          {form.taskType === "FRAUD" ? "Notes" : getNotesFieldLabel(form.taskType)}
          <textarea rows={2} value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} required />
        </label>
        {form.taskType !== "OOO" && (
          <label className="span-full">
            Humperdink Link
            <input
              type="text"
              inputMode="url"
              placeholder="Optional"
              value={form.humperdinkLink}
              onChange={(e) => setForm((c) => ({ ...c, humperdinkLink: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !/^https?:\/\//i.test(v)) {
                  setForm((c) => ({ ...c, humperdinkLink: `https://${v}` }));
                }
              }}
            />
          </label>
        )}
        {/* One person, one of two things to do with them (issue #46 +
            ADR-0002). Share = "make sure they see this", task stays in the
            pool. Assign = hand it to them, task is born CLAIMED. The picker
            narrows to eligible recipients in Assign mode — a Fraud Check can
            only go to a file checker, same rule the server enforces — and a
            selection that stops being eligible is dropped rather than left to
            fail at submit. Hidden when there's nobody to point at. */}
        {recipientCandidates.length > 0 && (
          <div className="span-full form-direct">
            <div className="form-direct-head">
              <span>
                {form.pickerMode === "assign" ? "Assign Directly" : "Share Directly"}
                <span className="form-label-optional"> - Optional</span>
              </span>
              <div className="seg" role="group" aria-label="Share or assign">
                <button
                  type="button"
                  className={form.pickerMode === "share" ? "seg-on" : ""}
                  aria-pressed={form.pickerMode === "share"}
                  onClick={() => setForm((c) => ({ ...c, pickerMode: "share" }))}
                >
                  Share
                </button>
                <button
                  type="button"
                  className={form.pickerMode === "assign" ? "seg-on" : ""}
                  aria-pressed={form.pickerMode === "assign"}
                  onClick={() => setForm((c) => ({ ...c, pickerMode: "assign" }))}
                >
                  {ACTION_LABELS.ASSIGN}
                </button>
              </div>
            </div>
            <select
              aria-label={form.pickerMode === "assign" ? "Assign to" : "Share with"}
              value={form.recipientUserId}
              onChange={(e) => setForm((c) => ({ ...c, recipientUserId: e.target.value }))}
            >
              <option value="">No one — just create it</option>
              {recipientCandidates.map((u) => (
                <option key={u.id} value={u.id}>{u.displayName}</option>
              ))}
            </select>
            {form.recipientUserId && (
              <input
                type="text"
                value={form.recipientNote}
                placeholder="Add a note (optional)"
                maxLength={280}
                onChange={(e) => setForm((c) => ({ ...c, recipientNote: e.target.value }))}
              />
            )}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create Task"}</button>
        </div>
      </form>
      </div>
    </div>
  );
};

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  /* When set, the task list is filtered to a single Loan and shows its
     editable header (ADR-0001: click a loan name to filter + edit). */
  const [loanFilterId, setLoanFilterId] = useState<string | null>(null);
  /* Selectable people for the share and handoff pickers (issue #41, ADR-0002).
     Active users; carries roles so the handoff picker can filter to file
     checkers on a Fraud Check. */
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
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
  const [activeTab, setActiveTab] = useState<"active" | "all" | "metrics" | "admin">("active");

  /* Grouped ("courts") view toggle — buckets tasks by whose court the ball is
     in instead of one flat list. App-wide viewing preference, persisted so it
     survives reloads. Defaults on. */
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
  /* Task to focus from a Teams deep link (bot card "Open in Hot Task" carries
     the task id as subEntityId). Held until the task is present in `tasks`,
     then expanded + scrolled into view by the effect below. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
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
  const setExpandOverride = useCallback((taskId: string, open: boolean): void => {
    setExpandOverrides((prev) => ({ ...prev, [taskId]: open }));
  }, []);
  /* Collapse all (#177): one merged write for the whole visible list, not one
     setState per card. The entries it adds are ordinary manual collapses,
     indistinguishable from clicking each row shut — and since nothing clears
     an expand behind the viewer any more (#161), they stay collapsed until the
     viewer opens them again. */
  const collapseAllTasks = useCallback((taskIds: string[]): void => {
    setExpandOverrides((prev) => collapseTasks(prev, taskIds));
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
    setExpandOverride(target, true);
    const raf = requestAnimationFrame(() => {
      document.getElementById(`task-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setFocusTaskId(null);
    return () => cancelAnimationFrame(raf);
  }, [focusTaskId, tasks]);
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
    if (!isAdmin && (activeTab === "metrics" || activeTab === "all" || activeTab === "admin")) {
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
        applyTheme(context.app?.theme ?? context.theme);
        teamsApp.registerOnThemeChangeHandler?.((theme) => applyTheme(theme));

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
        applyTheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        if (!IS_DEV) {
          setError("Unable to sign in. Open this app from Microsoft Teams.");
        }
      });
  }, []);

  useEffect(() => {
    /* In prod, hold the first fetch until SSO resolves a real identity.
       The placeholder user has an empty id (and dev-header auth would send a
       non-ASCII display name), so fetching now both 401s and risks a header
       encoding error. Dev always has a real mock id, so it runs immediately. */
    if (!IS_DEV && !user.id) return;
    refresh().catch(() => {});
    loadLoans().catch(() => {});
  }, [user.id]);

  useEffect(() => {
    /* Load the people directory for the share picker (issue #41). Same
       gate as the task fetch: hold until a real identity resolves in prod. */
    if (!IS_DEV && !user.id) return;
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

  /* Create-form submit seam (issue #72). <CreateTaskForm> owns the form state
     and builds the payload; App keeps the two side-effects — persistence and
     the post-create share — so the child stays presentational. Resolves once
     the task is persisted (the child then closes itself); rejects only when the
     create itself fails, after surfacing the error, so the form stays open. */
  const onCreate = async (payload: CreateTaskInput, shareWithUserId: string, note?: string): Promise<void> => {
    let created: { task: LoanTask };
    try {
      created = await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create task", { variant: "error" });
      throw err;
    }
    setError(null);
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
     anyway. It does wait for SSO in prod, where the placeholder identity has no
     id and the request would 401.

     The ref is what makes it one shot. StrictMode runs a mount effect twice in
     dev, and both passes see the same state. */
  const claimedOnArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!claimOnArrivalId || (!IS_DEV && !user.id)) {
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

  /* Edit a Loan's name/link (the app's first post-creation edit surface).
     Server propagates to every linked task; we refresh tasks + loans so the
     live reference is reflected everywhere. */
  const onSaveLoan = async (loanId: string, name: string, humperdinkLink: string): Promise<void> => {
    try {
      const trimmedLink = humperdinkLink.trim();
      const normLink = trimmedLink && !/^https?:\/\//i.test(trimmedLink) ? `https://${trimmedLink}` : trimmedLink;
      const { loan, merged } = await apiRequest<{
        loan: Loan;
        merged?: { intoLoanId: string; intoLoanName: string; mergedName: string };
      }>(
        `/loans/${loanId}`,
        { method: "PATCH", body: JSON.stringify({ name: name.trim(), humperdinkLink: normLink }) },
        user
      );
      setLoanFilterId(loan.id);
      setError(null);
      // ADR-0001: a shared Humperdink link auto-merges the two loans; surface
      // that so the edit doesn't silently fold this record into another. The
      // notice is a transient auto-dismiss toast (ADR-0001 addendum 2026-07-31).
      if (merged) {
        showToast(
          `Merged with "${merged.intoLoanName}", an existing loan sharing this Humperdink link.`,
          { variant: "info" }
        );
      }
      await refresh();
      await loadLoans();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update loan", { variant: "error" });
    }
  };

  const onUpdatePoints = useCallback(async (taskId: string, points: number): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/points`, { method: "POST", body: JSON.stringify({ points }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update poops", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* Amend the ask (ADR-0006). Two calls, mirroring the two server routes —
     nothing here can express a due date, because no route accepts one.
     `useMemo`'d as one object for the same reason `checklistApi` is: a fresh
     literal on every render would defeat TaskCard's memo for the whole list.

     Both rethrow after toasting, unlike `onUpdatePoints`: the edit panel holds a
     draft, so a refused save has to leave it open with the text still in it
     rather than swallow the rejection and close over the creator's typing. */
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

  const amendApi = useMemo<AmendApi>(() => ({
    setNotes: async (taskId, notes) => {
      try {
        await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/notes`, { method: "POST", body: JSON.stringify({ notes }) }, user);
        await refresh();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to update notes", { variant: "error" });
        throw err;
      }
    },
    setUrgency: async (taskId, urgency) => {
      try {
        await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/urgency`, { method: "POST", body: JSON.stringify({ urgency }) }, user);
        await refresh();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to update urgency", { variant: "error" });
        throw err;
      }
    }
  }), [user, refresh, showToast]);

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

  /* Stable so it doesn't defeat TaskCard's memo (#73) — was an inline arrow
     rebuilt inside `cardProps` every render. */
  const onFilterLoan = useCallback((loanId: string): void => {
    setLoanFilterId(loanId);
  }, []);

  /* Unified visible-task list. Closed tasks (COMPLETED / CANCELLED /
     ARCHIVED) older than CLOSED_TTL_DAYS drop off the bottom — admins can
     see everything ever via the All Tasks tab. CANCELLED rides the same
     retention window as the other closed statuses (it used to vanish
     immediately) so a just-cancelled task stays visible in Done before being
     pruned. Fraud Check claims are gated to FILE_CHECKERs in the workflow;
     the UI just hides the Claim button for viewers who can't act. Sort:
     celebrating (creator-only completion milestone) pinned to the very top →
     OPEN → in-flight → closed mini rows, newest-first within each bucket. */
  const CLOSED_TTL_DAYS = 14;
  const buildSorted = (includeOldClosed: boolean): LoanTask[] => {
    const cutoff = Date.now() - CLOSED_TTL_DAYS * 24 * 60 * 60 * 1000;
    const bucket = (t: LoanTask): number => {
      if (t.createdBy.id === user.id && isCelebratingStatus(t)) return 0;
      if (t.status === "OPEN") return 1;
      if (CLOSED_STATUSES.includes(t.status)) return 3;
      return 2;
    };
    return tasks
      .filter((t) => {
        if (includeOldClosed) return true;
        if (!CLOSED_STATUSES.includes(t.status)) return true;
        const stamp = t.completedAt ?? t.cancelledAt ?? t.archivedAt ?? t.updatedAt;
        return new Date(stamp).getTime() >= cutoff;
      })
      .sort((a, b) => {
        const diff = bucket(a) - bucket(b);
        if (diff !== 0) return diff;
        return b.createdAt.localeCompare(a.createdAt);
      });
  };
  const unifiedTasks = useMemo(() => buildSorted(false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, user.id]);
  const allTasksAdmin = useMemo(() => buildSorted(true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, user.id]);

  const activeCount = useMemo(() => unifiedTasks.filter((t) => !CLOSED_STATUSES.includes(t.status)).length, [unifiedTasks]);

  /* Re-bucket an already-filtered task list (closed-task TTL applied)
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
      if (court === "them" || court === "pool") {
        if (hasUnreadNoteForViewer(t, user, seenNotesAt[t.id])) {
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
      onAddCompletedNote,
      onUpdatePoints,
      amend: amendApi,
      taskHistory: taskHistoryApi,
      onFilterLoan,
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
      onSetExpand: setExpandOverride
    };
    /* The toggle only controls court bucketing — both views render the same
       compact row, so a task looks identical either way. Flat view is the
       whole list in one CardList; grouped view splits it into court sections. */
    if (!grouped) {
      return <CardList tasks={list} emptyMessage={emptyMessage} now={now} {...cardProps} />;
    }
    const sections = buildCourtSections(list).filter((s) => s.tasks.length > 0);
    if (sections.length === 0) {
      return <div className="empty-card">{emptyMessage}</div>;
    }
    return (
      <div className="courts">
        {sections.map((s) => (
          <section className="court" key={s.key} data-court={s.key}>
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
              className={`tab-btn${activeTab === "all" ? " tab-active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All Tasks
              <span className="section-count">{allTasksAdmin.length}</span>
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
              <select value={user.id} onChange={(e) => setUser(DEV_USERS.find((u) => u.id === e.target.value) ?? INITIAL_USER)}>
                {DEV_USERS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.roles.join("/")})
                  </option>
                ))}
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
          open; unmounting on close discards the draft. */}
      {formOpen && (
        <CreateTaskForm
          loans={loans}
          directory={directory}
          user={user}
          tasks={tasks}
          onClose={() => setFormOpen(false)}
          onCreate={onCreate}
        />
      )}

      {/* ── Unified task grid ──────────────────────── */}
      {activeTab === "active" && (() => {
        // A stale id (loan merged away) simply resolves to undefined → the
        // list renders unfiltered with no header, which is harmless.
        const activeLoan = loanFilterId ? loans.find((l) => l.id === loanFilterId) : undefined;
        if (activeLoan) {
          const filtered = unifiedTasks.filter((t) => t.loanId === activeLoan.id);
          return (
            <>
              <LoanFilterHeader
                loan={activeLoan}
                taskCount={filtered.length}
                onSave={onSaveLoan}
                onClear={() => setLoanFilterId(null)}
                grouped={grouped}
                onGroupedChange={setGrouped}
                formOpen={formOpen}
                onToggleForm={() => setFormOpen((o) => !o)}
                expandedIds={expandedIdsIn(filtered)}
                onCollapseAll={collapseAllTasks}
              />
              {renderTaskList(filtered, "No tasks for this loan.")}
            </>
          );
        }
        return (
          <>
            <div className="section-head task-grid-head">
              <h2>
                Tasks
                <span className="section-count">{unifiedTasks.length}</span>
              </h2>
              <GroupSeg grouped={grouped} onChange={setGrouped} />
              <CollapseAllButton expandedIds={expandedIdsIn(unifiedTasks)} scope="Tasks" onCollapse={collapseAllTasks} />
              <NewTaskButton open={formOpen} onClick={() => setFormOpen((o) => !o)} />
            </div>
            {renderTaskList(unifiedTasks, "No tasks yet.")}
          </>
        );
      })()}

      {/* ── All Tasks (admin) ────────────────────────── */}
      {activeTab === "all" && isAdmin && (
        <>
          <div className="section-head task-grid-head">
            <h2>All Tasks (admin)</h2>
            <span className="section-count">{allTasksAdmin.length} total · no age cutoff</span>
            <GroupSeg grouped={grouped} onChange={setGrouped} />
            <CollapseAllButton expandedIds={expandedIdsIn(allTasksAdmin)} scope="All Tasks" onCollapse={collapseAllTasks} />
            <NewTaskButton open={formOpen} onClick={() => setFormOpen((o) => !o)} />
          </div>
          {renderTaskList(allTasksAdmin, "No tasks yet.")}
        </>
      )}

      {/* ── Metrics tab content ─────────────────────── */}
      {activeTab === "metrics" && isAdmin && (
        <MetricsPanel leaderboard={claimsLeaderboard} totals={statusTotals} typeBreakdown={typeBreakdown} />
      )}

      {/* ── Admin tab content ───────────────────────── */}
      {activeTab === "admin" && isAdmin && <AdminPanel user={user} />}
    </main>
  );
};
