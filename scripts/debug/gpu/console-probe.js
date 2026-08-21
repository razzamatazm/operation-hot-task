/* Paste into the DevTools console of the REAL tab that spins your GPU,
   then leave the tab alone for 10s. Reports what JS can see about why the
   page might be doing continuous work.

   Note: it deliberately does NOT try to measure FPS via requestAnimationFrame
   — calling rAF *requests* a frame, so a rAF counter always reads ~60fps and
   tells you nothing. Use DevTools → Rendering → Frame Rendering Stats for
   actual frame rate. */
(() => {
  const SECONDS = 10;

  const running = document.getAnimations().filter((a) => a.playState === "running");
  const infinite = running.filter((a) => {
    const t = a.effect && a.effect.getTiming();
    return t && (t.iterations === Infinity || t.iterations === null);
  });

  const describe = (a) => {
    const el = a.effect && a.effect.target;
    const t = a.effect && a.effect.getTiming();
    return {
      name: a.animationName || a.constructor.name,
      iterations: t && t.iterations,
      durationMs: t && t.duration,
      el: el ? el.tagName.toLowerCase() + "." + (el.getAttribute("class") || "").split(" ").slice(0, 3).join(".") : null,
    };
  };

  // Elements whose computed style forces a compositor layer or heavy GPU work.
  const heavy = {};
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    const add = (k) => (heavy[k] = (heavy[k] || 0) + 1);
    if (s.willChange && s.willChange !== "auto") add("will-change: " + s.willChange);
    if (s.backdropFilter && s.backdropFilter !== "none") add("backdrop-filter");
    if (s.filter && s.filter !== "none") add("filter: " + s.filter);
    if (s.animationIterationCount === "infinite") add("infinite animation: " + s.animationName);
    if (s.position === "fixed") add("position: fixed");
    if (s.backgroundAttachment === "fixed") add("background-attachment: fixed");
  }

  let mutations = 0;
  const mo = new MutationObserver((recs) => (mutations += recs.length));
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });

  const longTasks = [];
  let po;
  try {
    po = new PerformanceObserver((l) => longTasks.push(...l.getEntries().map((e) => Math.round(e.duration))));
    po.observe({ entryTypes: ["longtask"] });
  } catch { /* longtask unsupported */ }

  console.log(`[gpu-probe] watching for ${SECONDS}s — leave the tab idle...`);

  setTimeout(() => {
    mo.disconnect();
    if (po) po.disconnect();
    console.log("=== gpu-probe result ===");
    console.log("DOM nodes:", document.querySelectorAll("*").length);
    console.log("running animations:", running.length, "of which infinite:", infinite.length);
    if (running.length) console.table(running.map(describe));
    console.log("GPU-heavy computed styles:", heavy);
    console.log(`DOM mutations while idle: ${mutations} (${(mutations / SECONDS).toFixed(1)}/sec)`);
    console.log("long tasks (ms):", longTasks);
    console.log(
      mutations / SECONDS > 5 || infinite.length > 0
        ? ">>> SUSPECT: the page is doing continuous work while idle."
        : ">>> Page looks quiet at the JS level. If the GPU is still spinning, check DevTools → Rendering → Frame Rendering Stats, and Shift+Esc to confirm which tab/process is responsible.",
    );
  }, SECONDS * 1000);
})();
