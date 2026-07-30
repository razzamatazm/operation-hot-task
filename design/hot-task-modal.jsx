// Hot Task — New Task modal + Design Notes panel
const NewTaskModal = ({ user, onClose, onCreate }) => {
  const [type, setType] = React.useState("LOI");
  const [folder, setFolder] = React.useState("");
  const [urgency, setUrgency] = React.useState("GREEN");
  const [points, setPoints] = React.useState(1);
  const [hover, setHover] = React.useState(null);
  const [notes, setNotes] = React.useState("");
  const [link, setLink] = React.useState("");
  const meta = TASK_TYPE_META[type];
  const isOoo = type === "OOO";
  const first = user.displayName.split(" ")[0];

  const submit = (e) => {
    e.preventDefault();
    if (!folder.trim()) return;
    onCreate({ taskType: type, folderName: folder.trim(), urgency, points, notes: notes.trim(), humperdinkLink: link.trim() });
  };

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>New Hot Task</h2>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {/* 1 — what do you need? */}
          <div className="field">
            <label>What do you need?</label>
            <div className="type-grid">
              {Object.keys(TASK_TYPE_META).map((k) => {
                const m = TASK_TYPE_META[k];
                return (
                  <button type="button" key={k} className={"type-opt" + (type === k ? " on" : "")} onClick={() => setType(k)}>
                    <span className="type-glyph" style={{ background: m.color }}>{m.glyph}</span>
                    <span className="to-name">{m.label}</span>
                    <span className="to-desc">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* live headline preview — exactly what the channel post will say */}
          <div className="headline-preview">
            <Flame className="flame" />
            <span className="hp-text"><b>{first}</b> {meta.phrase}{folder.trim() ? <> on <b>{folder.trim()}</b></> : ""}</span>
          </div>

          <div className="grid-2">
            <div className="field">
              <label>Folder name</label>
              <input type="text" placeholder="e.g. 2021 Broadway RWC LLC – Adams" value={folder} onChange={(e) => setFolder(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Humperdink link <span style={{ opacity: 0.6, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
              <input type="text" placeholder="https://humperdink/…" value={link} onChange={(e) => setLink(e.target.value)} disabled={isOoo} />
            </div>
          </div>

          {/* 2 — how soon? */}
          {!isOoo && (
            <div className="field">
              <label>How soon?</label>
              <div className="urg-grid">
                {["GREEN", "YELLOW", "ORANGE", "RED"].map((u) => {
                  const um = URGENCY_META[u];
                  return (
                    <button type="button" key={u} className={"urg-opt" + (urgency === u ? " on-" + um.key : "")} onClick={() => setUrgency(u)}>
                      <span className={"udot udot-" + um.key}></span>
                      <span className="uname">{u === "GREEN" ? "Standard" : u === "YELLOW" ? "Today" : u === "ORANGE" ? "1 Hour" : "Now"}</span>
                      <span className="utime">{um.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3 — how bad? */}
          <div className="grid-2">
            <div className="field">
              <label>How bad? <span style={{ opacity: 0.6, textTransform: "none", letterSpacing: 0 }}>(counts on the leaderboard)</span></label>
              <div style={{ display: "flex" }}>
                <span className="dink-pick" onMouseLeave={() => setHover(null)}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button type="button" key={n} className={n <= (hover ?? points) ? "on" : ""}
                      onClick={() => setPoints(n)} onMouseEnter={() => setHover(n)}>💩</button>
                  ))}
                </span>
                <span className="dink-caption">{DINK_CAPTIONS[hover ?? points]}</span>
              </div>
            </div>
            {isOoo && (
              <div className="field">
                <label>Return date</label>
                <input type="text" placeholder="YYYY-MM-DD" />
              </div>
            )}
          </div>

          <div className="field">
            <label>{meta.notesLabel}</label>
            <textarea placeholder={type === "LOI" ? "Terms to check + who to contact…" : type === "FRAUD" ? "What looks off, and what's outstanding…" : "What does the assignee need to know?"} value={notes} onChange={(e) => setNotes(e.target.value)}></textarea>
          </div>
        </div>
        <div className="modal-foot">
          <span style={{ fontSize: "0.74rem", color: "var(--muted)" }}>
            {isOoo ? "Auto-completes at 8:30 AM on the return date." : "Posts to the channel · DMs whoever claims it."}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-accent" disabled={!folder.trim()}>🔥 Light it up</button>
          </div>
        </div>
      </form>
    </div>
  );
};

/* ── Design notes (what changed & why) ─────────────────────── */
const DESIGN_NOTES = [
  { t: "Whose court is it?", p: "Every row now answers the one question that matters in a relay app: who has the next move. Tasks group into “Needs you”, “Up for grabs”, “Waiting on others” instead of one flat list." },
  { t: "Urgency is a live countdown", p: "dueAt is already computed server-side — so show “2h 14m” ticking down, not a static label. Overdue flips red with a pulse. The left stripe encodes urgency color." },
  { t: "The pulse at the top", p: "A focus strip answers “how's my day?” in one glance — needs-you, overdue, waiting-on counts. Each cell is also a filter." },
  { t: "One primary action per row", p: "Claim / Complete / Approve Merge / Archive — the workflow's botPrimaryAdvance logic, surfaced as a single green button. No hunting in the expanded view." },
  { t: "Conversation stays attached", p: "The notes thread lives inside the task with a real composer, unread dots, and the per-type brief (“Loan Terms and Contacts”) pinned on top." },
  { t: "New Task = 3 questions", p: "What do you need? How soon? How bad? Type-first picker with role hints, urgency as labeled buttons (Standard/Today/1 Hour/Now), and a live preview of the channel headline." },
  { t: "Personality kept", p: "The flame, the “How Bad?” 💩 scale, and the warm ledger palette are all yours — Bricolage Grotesque, DM Sans, JetBrains Mono, same hex values from styles.css." }
];

const DesignNotes = () => {
  const [open, setOpen] = React.useState(false);
  return (
    <React.Fragment>
      <button className="notes-toggle" onClick={() => setOpen(!open)}>
        {open ? "✕ Close notes" : "✦ Design notes"}
      </button>
      {open && (
        <div className="notes-panel">
          <h3>What changed &amp; why</h3>
          <p className="np-sub">Seven ideas, all rooted in your real data model (types.ts / workflow.ts) and your existing design tokens.</p>
          {DESIGN_NOTES.map((n, i) => (
            <div className="np-item" key={i}>
              <h4><span className="np-num">{i + 1}</span>{n.t}</h4>
              <p>{n.p}</p>
            </div>
          ))}
        </div>
      )}
    </React.Fragment>
  );
};

Object.assign(window, { NewTaskModal, DesignNotes });
