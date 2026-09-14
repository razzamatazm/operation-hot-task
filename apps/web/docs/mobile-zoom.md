# Zoom is off on mobile

The long form of the mobile rules in [../CLAUDE.md](../CLAUDE.md), moved out of
that file on 2026-09-14 so it loads only when it is needed. Read it before
touching the viewport meta, `touch-action`, `src/zoom-guard.ts`, the
`pointer: coarse` floors or the size of a press target.

The app is hosted in the Teams mobile webview, which has no address bar and no
zoom-reset control, so a stray pinch or double-tap leaves someone magnified into
a corner of a task list with no obvious way back. Zoom is suppressed outright.

It takes three layers, because no single one covers every gesture, and
`scripts/zoom-guard-sim-test.mjs` holds all three — dropping any one of them
turns that test red:

1. **The viewport meta** in [index.html](../index.html) —
   `maximum-scale=1.0, user-scalable=no`. Android/Chromium honours it; iOS does
   not.
2. **`touch-action: pan-x pan-y` on `html, body`** in
   [src/styles.css](../src/styles.css) — scrolling both ways stays, pinch and
   double-tap-zoom go. `manipulation` is not enough; it only takes the
   double-tap. This rule is what takes **double-tap on every engine**, iOS
   included, which is why the JS layer below deliberately doesn't.
   `touch-action` intersects down the ancestor chain rather than being
   overridden by a descendant, so the hold-to-edit box and the message bubbles
   keep working only because their `pan-y` is a subset of this. Narrow the base
   rule and you break both; there is a test for that pair.
3. **[src/zoom-guard.ts](../src/zoom-guard.ts)**, installed on `document` from
   `main.tsx` — the **iOS pinch**, and nothing else. It cancels the `gesture*`
   events, which WKWebView fires regardless of the viewport meta, and cancels a
   two-finger `touchmove`.

**Never cancel a `touchend` here.** A JS double-tap blocker lived in layer 3
briefly and broke the app: cancelling a `touchend` cancels the whole synthesized
mouse sequence after it, `click` and focus included, so suppressing the second
tap of a pair also swallowed that tap's press — two quick checks down a
checklist lost the second one, as did a tap into a field beside the control just
pressed. Layer 2 takes double-tap without touching the click, which is the whole
reason to prefer the declarative rule. The test asserts the guard registers no
`touchend` handler.

A fourth thing is the same bug wearing different clothes: **iOS zooms the page
in when a field under 16px takes focus**, and with zoom pinned off it never
zooms back out. The `@media (pointer: coarse)` block takes `input, select,
textarea` to 16px on touch devices; desktop, where the behaviour doesn't exist,
keeps the tighter type.

That rule carries `!important`, and it is load-bearing. A bare element selector
is specificity 0,0,1 and a media query adds none, so without it the floor loses
to every class-scoped field in the app — `.composer textarea`, `.msg-edit
textarea`, `.checklist-item-input` and the rest all sit at 0.85rem and kept
zooming the page on focus, the message composer being the field people touch
most. Sizing them one at a time is the trap: the next field added under 16px
inherits the bug silently. It is a blanket platform rule, so it is written as
one, and a test fails if any control rule ever outranks it.

**The same argument floors the text people read, not just the fields they type
into** (2026-09-06). The 16px input rule exists because rendered size is the
only size there is here; that was true of the labels too, and they were not
covered. Measured on the live board at 390px, the due labels rendered at
**8.8px**, the waiting label at 9.6px, the person chips at 8.96px and the type
label at 10.88px — none of them a pixel different from their 1440px size, on the
one surface with no way to go and look. `OVERDUE BY` is the case that decides
it: colour is never the only signal here, and the words beside the red date are
the second channel the accessibility notes claim.

The floor is the **last block in `styles.css`**, under `## Touch floors`, for
the reason every phone override is at the bottom: a media query adds no
specificity, so a rule written above the ones it raises loses silently. 11px for
the mono labels, 12px for the type cell, its step and the two list headings,
and 13.5px for the type's own words on an active row, which sit a step over the
cell at every width (2026-09-13, the user's call). Mini rows keep the cell's size:
their one-line title cut the larger type between about 570 and 620px. It is scoped
to `pointer: coarse` rather than to a width, matching the input rule — the
constraint is the device and the missing zoom, not the viewport, and a narrow
desktop window can still be dragged wider.

**A press target grows by an overlay, never by a size.** The two menu triggers
take a 40px `::after` rather than a 40px box, because 32px is not a loose
number: the row's action column is that hamburger plus 6px plus
`--quick-action-w`, and the list header is built to land its own trigger on top
of it. 40 and not 44 — the halo clears each edge by 4px and the quick action
sits 6px away, so at 44 the two targets would meet and a press in the overlap
would go to whichever the browser hit-tests first.

Still unfixed and deliberately so: the checklist checkbox (18x18), its `+ note`
button (37x13) and the loan-name link (114x18). All three sit inside dense rows
with other controls within a few pixels, so a halo would overlap a neighbouring
target and steal presses. They need a layout decision, not a floor.

This is a deliberate accessibility trade: someone who needs magnification has
to use the OS-level zoom rather than the page's. It is the right call inside a
chrome-less webview where page zoom is a trap, and it should not be copied to a
surface that has a way back out.
