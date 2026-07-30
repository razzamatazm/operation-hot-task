// Hot Task — UI components (task rows, expand, modal, focus strip)
const { useState, useEffect, useRef } = React;

const Flame = ({ className }) => (
  <svg className={className || "brand-logo"} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path>
  </svg>
);

const Avatar = ({ userId, size }) => {
  const u = userById(userId);
  const cls = size === "mini" ? "mini-avatar" : "avatar";
  return <span className={cls} style={{ background: u ? u.color : "#8a847a" }}>{initials(userId)}</span>;
};

const TypeGlyph = ({ type, big }) => {
  const m = TASK_TYPE_META[type];
  return <span className="type-glyph" style={{ background: m.color }}>{m.glyph[0]}</span>;
};

/* Severity — three visual treatments, switchable via Tweaks */
const Severity = ({ points, style }) => {
  if (style === "bars") {
    return (
      <span className="sev-bars" title={`How bad? ${points}/5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <i key={n} className={(n <= points ? "on " : "") + "s" + n} style={{ height: 4 + n * 2 + "px" }}></i>
        ))}
      </span>
    );
  }
  if (style === "number") {
    return <span className="sev-num" title="How bad?"><b>{points}</b>/5 💩</span>;
  }
  return (
    <span className="dinks" title={`How bad? ${points}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={"pip" + (n <= points ? " on" : "")}>💩</span>
      ))}
    </span>
  );
};

/* Live urgency countdown cell */
const UrgencyCell = ({ task, now, showCountdown, calm }) => {
  const meta = URGENCY_META[task.urgency];
  const closed = CLOSED.includes(task.status);
  if (closed) {
    if (calm) return <div className="urg"><span className="urg-quiet">✓ {ago(task.completedAt || task.dueAt)}</span></div>;
    return (
      <div className="urg">
        <span className="urg-time">✓ done</span>
        <span className="urg-label">{ago(task.completedAt || task.dueAt)}</span>
      </div>
    );
  }
  const cd = countdown(task.dueAt, now);
  /* Calm: only shout when it matters — overdue or due within 4 hours.
     Everything else gets a quiet shorthand. */
  if (calm && !cd.overdue && task.dueAt - now > 4 * 3600000) {
    const short = { GREEN: "24h", YELLOW: "EOD", ORANGE: "1h", RED: "now" }[task.urgency];
    return (
      <div className="urg">
        <span className="urg-label">Due in</span>
        <span className="urg-quiet">{short}</span>
      </div>
    );
  }
  if (!showCountdown) {
    return (
      <div className="urg">
        <span className="urg-time" style={{ fontSize: "0.78rem" }}>{meta.label}</span>
        {cd.overdue ? <span className="urg-overdue">Overdue</span> : <span className="urg-label">{meta.key}</span>}
      </div>
    );
  }
  return (
    <div className="urg">
      {cd.overdue
        ? <span className="urg-overdue">Overdue by</span>
        : <span className="urg-label">Due in</span>}
      <span className="urg-time">{cd.text}</span>
    </div>
  );
};

/* Whose-court cell */
const TurnCell = ({ move, calm }) => (
  <div className="turn">
    <span className={"turn-who turn-" + move.court}>
      <span className="turn-dot"></span>
      {move.who}
    </span>
    {!calm && <span className="turn-step">{move.step}</span>}
  </div>
);

/* People cell — who's on the hook (top) + who assigned it (bottom).
   Always shown, including on done tasks, so "who's busy" reads at a glance. */
const PeopleCell = ({ task }) => (
  <div className="people">
    <span className="person" title={"Assigned to " + (task.assignee ? name(task.assignee) : "no one yet")}>
      <span className="person-role">Owner</span>
      {task.assignee
        ? <React.Fragment><Avatar userId={task.assignee} size="mini" /><span className="person-name">{name(task.assignee)}</span></React.Fragment>
        : <React.Fragment><span className="person-none-dot"></span><span className="person-name is-unclaimed">Unclaimed</span></React.Fragment>}
    </span>
    <span className="person person-by" title={"Assigned by " + name(task.createdBy)}>
      <span className="person-role">From</span>
      <Avatar userId={task.createdBy} size="mini" />
      <span className="person-name">{name(task.createdBy)}</span>
    </span>
  </div>
);

/* ── Task row + expanded body ──────────────────────────────── */
function TaskRow({ task, user, now, open, onToggle, onAction, onNote, showCountdown, calm, mono }) {
  const move = nextMove(task, user);
  const meta = TASK_TYPE_META[task.taskType];
  const closed = CLOSED.includes(task.status);
  const overdue = isOverdue(task, now);
  const [draft, setDraft] = useState("");
  const unread = task.unreadFor === user.id;

  const urgCls = closed ? "" : "urg-" + URGENCY_META[task.urgency].key;
  const washCls = closed ? "is-done" : calm ? "" : move.court === "you" ? "wash-you" : move.pool ? "wash-pool" : "";
  /* Calm: only "your move" rows keep a persistent button; others reveal on hover. */
  const revealCls = calm && move.court !== "you" ? " btn-reveal" : "";
  /* Mono: the turn cell merges into the action slot — a button when it's
     your move, otherwise three quiet words about where it sits. */
  const withText = move.court === "them" ? "with " + move.who
    : move.pool ? "unclaimed"
    : move.court === "done" ? "" : move.who;

  const send = () => {
    if (!draft.trim()) return;
    onNote(task.id, draft.trim());
    setDraft("");
  };

  return (
    <div className="row-wrap">
      <div
        className={`row ${urgCls} ${washCls} ${open ? "is-open" : ""}${overdue && !closed ? " is-overdue" : ""}`}
        onClick={() => onToggle(task.id)}
        role="button"
        aria-expanded={open}
      >
        <span className="row-stripe"></span>
        <PeopleCell task={task} />
        <div className="row-main">
          <span className="row-type"><TypeGlyph type={task.taskType} />{meta.label}<span className="title-pips" title={`How bad? ${task.points}/5`}>{Array.from({ length: task.points }).map(() => "💩").join("")}</span>{unread && <span className="unread" title="New note"></span>}</span>
          <span className="row-folder">
            {task.humperdinkLink
              ? <a className="lnk" href={task.humperdinkLink} onClick={(e) => e.stopPropagation()}>{task.folderName} ↗</a>
              : task.folderName}
          </span>
        </div>
        {!mono && <TurnCell move={move} calm={calm} />}
        <div className="row-action" onClick={(e) => e.stopPropagation()}>
          <UrgencyCell task={task} now={now} showCountdown={showCountdown} calm={calm} />
          {move.action && (
            <button
              className={"btn btn-sm " + (move.action.kind === "good" ? "btn-good" : "btn-quiet") + revealCls}
              onClick={() => onAction(task.id, move.action.to)}
            >{move.action.label}</button>
          )}
        </div>
      </div>

      {open && (
        <div className="expand">
          {/* Meta facts live in one slim strip up top — the columns below
             belong to the flow (timeline) and the conversation. */}
          <div className="expand-strip">
            <span className="strip-item"><label>Assigner</label><span className="v"><Avatar userId={task.createdBy} size="mini" />{name(task.createdBy)}</span></span>
            <span className="strip-item"><label>Assignee</label><span className="v">{task.assignee ? <React.Fragment><Avatar userId={task.assignee} size="mini" />{name(task.assignee)}</React.Fragment> : <span className="v-pending">Pending</span>}</span></span>
            <span className="strip-item"><label>Created</label><span className="v">{dateTime(task.createdAt)}</span></span>
            <span className="strip-item"><label>Due</label><span className={"v" + (overdue ? " v-due-late" : "")}>{dateTime(task.dueAt)}</span></span>
            {task.returnDate && <span className="strip-item"><label>Returns</label><span className="v">{task.returnDate}</span></span>}
          </div>
          <div className="expand-cols">
          <div className="expand-meta">
            <Timeline task={task} />
            <div className="expand-actions">
              {task.status === "CLAIMED" && isAssignee(task, user) && (
                <button className="btn btn-sm btn-ghost" onClick={() => onAction(task.id, "OPEN")}>Unclaim</button>
              )}
              {task.status === "CLAIMED" && (isCreator(task, user) || isAssignee(task, user)) && (
                <button className="btn btn-sm btn-ghost" onClick={() => onAction(task.id, "NEEDS_REVIEW")}>Needs Review</button>
              )}
              {task.status === "COMPLETED" && (isCreator(task, user) || isAssignee(task, user)) && (
                <button className="btn btn-sm btn-ghost" onClick={() => onAction(task.id, "OPEN")}>Re-open</button>
              )}
              {!closed && isCreator(task, user) && (
                <button className="btn btn-sm btn-ghost" style={{ color: "var(--bad)" }} onClick={() => onAction(task.id, "CANCELLED")}>Cancel Task</button>
              )}
            </div>
          </div>

          <div className="thread">
            <div className="thread-head">{TASK_TYPE_META[task.taskType].notesLabel}</div>
            <div className="note-brief"><b>{name(task.createdBy)}:</b> {task.notes}</div>
            {task.msgs.length > 0 && (
              <div className="msgs">
                {task.msgs.map((m, i) => (
                  <div key={i} className={"msg" + (m.by === user.id ? " msg-mine" : "")}>
                    <Avatar userId={m.by} size="mini" />
                    <div>
                      <div className="msg-meta">
                        <span className="msg-author">{name(m.by)}</span>
                        <span className="msg-time">{dateTime(m.at)}</span>
                      </div>
                      <div className="msg-text">{m.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!closed && (
              <div className="composer">
                <textarea
                  rows={1}
                  placeholder={"Reply to " + (isCreator(task, user) ? (task.assignee ? name(task.assignee) : "the pool") : name(task.createdBy)) + "…"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                <button className="btn btn-sm" onClick={send} disabled={!draft.trim()}>Send</button>
              </div>
            )}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* status timeline inside expand */
function Timeline({ task }) {
  const flow = task.taskType === "LOAN_DOCS"
    ? ["OPEN", "CLAIMED", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED"]
    : ["OPEN", "CLAIMED", "COMPLETED"];
  const labels = { OPEN: "Opened", CLAIMED: "Claimed", MERGE_DONE: "Merge done", MERGE_APPROVED: "Merge approved", COMPLETED: "Completed", NEEDS_REVIEW: "Needs review" };
  const effective = task.status === "NEEDS_REVIEW" ? "CLAIMED" : task.status;
  const idx = flow.indexOf(effective);
  return (
    <div className="timeline">
      {flow.map((s, i) => {
        const done = i <= idx;
        const current = i === idx && !CLOSED.includes(task.status);
        return (
          <div key={s} className="tl-item">
            <span className="tl-dot" style={{ background: done ? (s === "COMPLETED" && task.status === "COMPLETED" ? "var(--good)" : "var(--brand)") : "var(--line)" }}></span>
            <div className="tl-body">
              <b style={{ color: done ? "var(--ink)" : "var(--muted)" }}>{labels[s]}</b>
              {current && task.status === "NEEDS_REVIEW" && <span className="tag tag-warn" style={{ marginLeft: 7 }}>NEEDS REVIEW</span>}
              {current && task.status !== "NEEDS_REVIEW" && <span className="tag tag-brand" style={{ marginLeft: 7 }}>NOW</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Focus strip ───────────────────────────────────────────── */
function FocusStrip({ user, tasks, now, filter, setFilter, calm }) {
  const active = tasks.filter((t) => !CLOSED.includes(t.status));
  const yourMove = active.filter((t) => nextMove(t, user).court === "you" && !nextMove(t, user).pool);
  const claimable = active.filter((t) => t.status === "OPEN" && canClaim(t, user));
  const overdue = active.filter((t) => isOverdue(t, now));
  const waiting = active.filter((t) => isCreator(t, user) && nextMove(t, user).court === "them");
  const first = user.displayName.split(" ")[0];
  const headline = yourMove.length + claimable.length === 0
    ? "Nothing needs you. Enjoy it."
    : `${yourMove.length + claimable.length} task${yourMove.length + claimable.length === 1 ? "" : "s"} need${yourMove.length + claimable.length === 1 ? "s" : ""} you`;
  const cell = (key, num, label, cls) => (
    <div
      className={"focus-cell" + (filter === key ? " is-active" : "")}
      onClick={() => setFilter(filter === key ? "all" : key)}
      role="button"
    >
      <span className={"focus-num " + (cls || "")}>{num}</span>
      <span className="focus-label">{label}</span>
    </div>
  );
  /* Calm: the whole strip becomes one slim pulse line. Zero-count chips vanish. */
  if (calm) {
    const chips = [
      { key: "yours", n: yourMove.length + claimable.length, label: "need you", cls: "pulse-bad" },
      { key: "overdue", n: overdue.length, label: "overdue", cls: "pulse-hot" },
      { key: "waiting", n: waiting.length, label: "waiting", cls: "pulse-brand" }
    ].filter((c) => c.n > 0);
    return (
      <div className="pulse-line">
        <span className="pulse-hello">{new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
        {chips.length === 0
          ? <span className="pulse-clear">All clear, {first}. Nothing needs you. ☕</span>
          : chips.map((c) => (
              <button key={c.key} className={"pulse-chip " + c.cls + (filter === c.key ? " is-active" : "")}
                onClick={() => setFilter(filter === c.key ? "all" : c.key)}>
                <b>{c.n}</b> {c.label}
              </button>
            ))}
      </div>
    );
  }
  return (
    <div className="focus-strip">
      <div className="focus-cell focus-hero">
        <span className="focus-greeting">{new Date(now).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
        <span className="focus-headline">{first}, {headline}</span>
        <span className="focus-sub">{overdue.length > 0 ? `${overdue.length} overdue — handle the red ones first.` : "Nothing overdue. Keep it that way."}</span>
      </div>
      {cell("yours", yourMove.length + claimable.length, "Need you", "focus-num-bad")}
      {cell("overdue", overdue.length, "Overdue", "focus-num-hot")}
      {cell("waiting", waiting.length, "You're waiting on", "focus-num-brand")}
    </div>
  );
}

Object.assign(window, { Flame, Avatar, TypeGlyph, Severity, UrgencyCell, TurnCell, PeopleCell, TaskRow, Timeline, FocusStrip });
