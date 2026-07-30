// Hot Task — main app: courts grouping, filters, tweaks, state
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "mode": "mono",
  "grouping": "courts",
  "density": "regular",
  "showCountdown": true,
  "quietCard": true,
  "accent": "#c25e00"
} /*EDITMODE-END*/;

function HotTaskApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [userId, setUserId] = React.useState("u-tyler");
  const [tasks, setTasks] = React.useState(SEED_TASKS);
  const [openId, setOpenId] = React.useState(null);
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [modal, setModal] = React.useState(false);
  const [toasts, setToasts] = React.useState([]);
  const [now, setNow] = React.useState(Date.now());
  const [doneOpen, setDoneOpen] = React.useState(false);
  const user = userById(userId);
  const calm = t.mode !== "full";
  const mono = t.mode === "mono";

  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    document.documentElement.style.setProperty("--accent", t.accent);
  }, [t.accent]);

  const toast = (text) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((c) => [...c, { id, text }]);
    setTimeout(() => setToasts((c) => c.filter((x) => x.id !== id)), 3200);
  };

  const transition = (taskId, to) => {
    setTasks((cur) => cur.map((task) => {
      if (task.id !== taskId) return task;
      const next = { ...task, status: to };
      if (to === "CLAIMED" && task.status === "OPEN") {next.assignee = user.id;toast(`Claimed — it's yours, ${name(user.id)}.`);} else
      if (to === "OPEN" && task.status === "CLAIMED") {next.assignee = null;toast("Unclaimed — back in the pool.");} else
      if (to === "OPEN") {next.assignee = task.assignee;next.completedAt = undefined;toast("Re-opened.");} else
      if (to === "COMPLETED") {next.completedAt = Date.now();toast("Completed 🔥 " + name(task.createdBy) + " gets a DM.");} else
      if (to === "MERGE_DONE") {toast("Merge done — " + name(task.createdBy) + " will review.");} else
      if (to === "MERGE_APPROVED") {toast("Merge approved — back to " + name(task.assignee) + " to finish.");} else
      if (to === "ARCHIVED") {toast("Archived. Auto-purges in 90 days.");} else
      if (to === "CANCELLED") {toast("Task cancelled.");} else
      if (to === "NEEDS_REVIEW") {toast("Flagged for review.");}
      return next;
    }));
  };

  const addNote = (taskId, text) => {
    setTasks((cur) => cur.map((task) => task.id === taskId ?
    { ...task, msgs: [...task.msgs, { by: user.id, at: Date.now(), text }], unreadFor: undefined } :
    task));
    toast("Note sent — counterpart gets a DM.");
  };

  const createTask = (input) => {
    const id = "t" + Math.random().toString(36).slice(2, 7);
    const dueMap = { RED: 0, ORANGE: 1, YELLOW: 6, GREEN: 24 };
    setTasks((cur) => [{
      id, ...input, status: "OPEN", assignee: null,
      dueAt: Date.now() + dueMap[input.urgency || "GREEN"] * 3600000,
      createdAt: Date.now(), createdBy: user.id, msgs: []
    }, ...cur]);
    setModal(false);
    toast("🔥 Task is live — posted to the channel.");
  };

  const toggle = (id) => {
    setOpenId((c) => c === id ? null : id);
    setTasks((cur) => cur.map((task) => task.id === id && task.unreadFor === user.id ? { ...task, unreadFor: undefined } : task));
  };

  /* filtering */
  const q = query.trim().toLowerCase();
  const visible = tasks.filter((task) => {
    if (q && !(task.folderName.toLowerCase().includes(q) || TASK_TYPE_META[task.taskType].label.toLowerCase().includes(q))) return false;
    const mv = nextMove(task, user);
    if (filter === "yours") return !CLOSED.includes(task.status) && mv.court === "you";
    if (filter === "overdue") return isOverdue(task, now);
    if (filter === "waiting") return !CLOSED.includes(task.status) && isCreator(task, user) && mv.court === "them";
    return true;
  });

  /* grouping into courts */
  const courts = [];
  if (t.grouping === "courts") {
    const buckets = { you: [], pool: [], wait: [], done: [] };
    visible.forEach((task) => {
      if (CLOSED.includes(task.status)) {buckets.done.push(task);return;}
      const mv = nextMove(task, user);
      if (mv.court === "you" && !mv.pool) buckets.you.push(task);else
      if (task.status === "OPEN") buckets.pool.push(task);else
      buckets.wait.push(task);
    });
    const sortDue = (a, b) => a.dueAt - b.dueAt;
    buckets.you.sort(sortDue);buckets.pool.sort(sortDue);buckets.wait.sort(sortDue);
    buckets.done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    courts.push(
      { key: "you", flag: "court-flag-you", title: "Needs you", sub: "Your move — these are blocking someone", items: buckets.you },
      { key: "pool", flag: "court-flag-pool", title: "Up for grabs", sub: "Open pool — first to claim scores the points", items: buckets.pool },
      { key: "wait", flag: "court-flag-wait", title: "Waiting on others", sub: "You'll get a DM when these move", items: buckets.wait },
      { key: "done", flag: "court-flag-done", title: "Done", sub: "Recently completed \u2014 who did what", items: buckets.done }
    );
  } else {
    const sorted = [...visible].sort((a, b) => {
      const ca = CLOSED.includes(a.status) ? 1 : 0,cb = CLOSED.includes(b.status) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return a.dueAt - b.dueAt;
    });
    courts.push({ key: "all", flag: "court-flag-pool", title: "All tasks", sub: "Sorted by due time", items: sorted });
  }

  return (
    <div className={"app-shell density-" + t.density + (calm ? " mode-calm" : "") + (mono ? " mode-mono" : "") + (t.quietCard ? " quiet-card" : "")}>
      <header className="top-bar top-bar-onerow">
        <div className="top-bar-left">
          <span className="brand"><Flame /><h1>Hot Task</h1></span>
        </div>
        <div className="top-bar-right">
          <div className="group-toggle">
            <span className="group-toggle-label">Grouped</span>
            <button
              className={"switch" + (t.grouping === "courts" ? " on" : "")}
              role="switch"
              aria-checked={t.grouping === "courts"}
              title={t.grouping === "courts" ? "Grouped into courts — click for a flat list" : "Flat list — click to group into courts"}
              onClick={() => setTweak("grouping", t.grouping === "courts" ? "flat" : "courts")}
            ><span className="switch-knob"></span></button>
          </div>
          <button className="btn btn-accent" onClick={() => setModal(true)}>+ New Task</button>
          <div className="actor">
            <span className="actor-label">Viewing as</span>
            <Avatar userId={userId} />
            <select value={userId} onChange={(e) => {setUserId(e.target.value);setOpenId(null);setFilter("all");}}>
              {USERS.map((u) =>
              <option key={u.id} value={u.id}>{u.displayName} · {u.roles.includes("FILE_CHECKER") ? "Checker" : "Loan Officer"}</option>
              )}
            </select>
          </div>
        </div>
      </header>

      {!calm && <FocusStrip user={user} tasks={tasks} now={now} filter={filter} setFilter={setFilter} calm={false} />}

      {courts.map((c) => {
        /* Calm: empty groups disappear entirely; Done folds into one line. */
        if (calm && c.items.length === 0 && c.key !== "all") return null;
        /* Done stays open — the point is to see who's been doing what. */
        const foldable = false;
        const folded = foldable && !doneOpen;
        return (
          <section className="court" key={c.key} data-screen-label={c.title}>
            <div
              className={"court-head" + (foldable ? " is-fold" : "")}
              onClick={foldable ? () => setDoneOpen((o) => !o) : undefined}
              role={foldable ? "button" : undefined}>
              
              <span className={"court-flag " + c.flag}></span>
              <span className="court-title">{c.title}</span>
              <span className="court-count">{c.items.length}</span>
              {foldable && <span className={"fold-chevron" + (doneOpen ? " open" : "")}>▶</span>}
              <span className="court-sub">{foldable && folded ? "" : c.sub}</span>
            </div>
            {folded ?
            null :
            c.items.length === 0 ?
            <div className="empty">{c.key === "you" ? "Nothing needs you. ☕" : "Nothing here."}</div> :
            c.items.map((task) =>
            <TaskRow
              key={task.id} task={task} user={user} now={now}
              open={openId === task.id} onToggle={toggle}
              onAction={transition} onNote={addNote}
              sevStyle="emoji" showCountdown={t.showCountdown} calm={calm} mono={mono} />

            )}
          </section>);

      })}

      {modal && <NewTaskModal user={user} onClose={() => setModal(false)} onCreate={createTask} />}

      <div className="toast-wrap">
        {toasts.map((x) => <div className="toast" key={x.id}><span className="tdot"></span>{x.text}</div>)}
      </div>

      <DesignNotes />

      <TweaksPanel>
        <TweakSection label="Layout" />
        <TweakRadio label="Mode" value={t.mode} options={["mono", "calm", "full"]} onChange={(v) => setTweak("mode", v)} />
        <TweakRadio label="Grouping" value={t.grouping} options={["courts", "flat"]} onChange={(v) => setTweak("grouping", v)} />
        <TweakRadio label="Density" value={t.density} options={["compact", "regular", "comfy"]} onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Signals" />
        <TweakToggle label="Live countdowns" value={t.showCountdown} onChange={(v) => setTweak("showCountdown", v)} />
        <TweakToggle label="Quiet card (one red, calm labels)" value={t.quietCard} onChange={(v) => setTweak("quietCard", v)} />
        <TweakSection label="Brand" />
        <TweakColor label="Accent" value={t.accent} options={["#c25e00", "#b82d35", "#2c5ea0", "#2e7d4f"]} onChange={(v) => setTweak("accent", v)} />
      </TweaksPanel>
    </div>);

}

ReactDOM.createRoot(document.getElementById("root")).render(<HotTaskApp />);