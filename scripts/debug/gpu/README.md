# GPU-spin debug harness

Throwaway measurement tools for "the app makes my GPU spin". Untracked /
disposable — delete once the question is settled.

All three launch their own Chrome with a fresh profile, so they see a
signed-out app unless you point them at a dev server (`import.meta.env.DEV`
gives the mock-user path and the real UI).

## frames.mjs — the decisive one

Counts frames Chrome actually *draws* for the page while it sits idle.
A quiet page draws ~0/sec; a page spinning the GPU draws ~60/sec. Immune to
other apps' GPU load, unlike any system-wide meter.

```
node scripts/debug/gpu/frames.mjs http://localhost:5173/ 8
# exit 0 = GREEN (quiet), exit 1 = RED (drawing while idle)
```

## scroll.mjs — differential scroll cost

Scrolls identically under several CSS overrides (`box-shadow: none`,
`transition: none`, `filter: none`, `border-radius: 0`) and reports raster /
paint / layout work per second for each. Whichever override collapses the cost
implicates that property.

```
URL=http://localhost:5173/ node scripts/debug/gpu/scroll.mjs 3
```

## ab-loop.mjs — system GPU A/B

Reads real macOS GPU utilization from `ioreg` (`AGXAccelerator` →
`Device Utilization %`) and alternates arms inside one warm Chrome, discarding
the first cycle so launch transients aren't attributed to an arm.

Caveat that cost me a false positive: `ioreg` is **system-wide**. A blank page
reads 10-18% purely from other apps. Trust `frames.mjs` over this one.

```
ARMS='[["blank","about:blank"],["app","http://localhost:5173/"]]' \
  node scripts/debug/gpu/ab-loop.mjs 4 6
```

## zen-loop.mjs — attribution for Zen / Firefox

Chrome's tracing API isn't available in Firefox, so this one answers the
coarser question: does the GPU spin because of *this app*, or does Zen spin on
anything? Arms are blank / a static no-JS control page / the app, launched in a
throwaway profile (never touches your real one), alternated across cycles.

```
node scripts/debug/gpu/zen-loop.mjs 3 12
```

Result on 2026-08-15: all three arms within noise of each other, total Zen CPU
0.1-0.3% across 12 processes. The app did not spin the GPU in Zen.

Caveat that matters: a throwaway profile has **no extensions, no other tabs,
and default Zen chrome settings**. Zen's own translucency/blur effects and
other tabs are not covered by this loop — check `about:processes` in the real
profile instead.

## Measuring a real session instead

These launch a clean Chrome, so they can't see your logged-in tab. For that:

- DevTools → ⋮ → More tools → **Rendering** → check **Frame Rendering Stats**.
  Sustained ~60fps on an idle page means something is animating.
- **Shift+Esc** (Chrome Task Manager) → right-click the header → enable
  **GPU Memory** / **Frames** to see which tab is responsible.
- Paste `console-probe.js` into the console of the real tab.
