/* The two inline glyphs used on both sides of the App/TaskForm split (#260).

   They were local to App.tsx while the create form lived there too. The form
   moved out into `task-form.tsx` so it can be rendered and asserted on in a
   test, and its outstanding-items seeder draws the same trash glyph the FRAUD
   checklist does — so the glyphs land here rather than being exported out of
   one feature module into another, or drawn twice.

   Both are decorative: the control around them carries the accessible name, so
   they are `aria-hidden` and out of the tab order. */

export const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M3 8.5l3.2 3.3L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M3 4.5h10M6.5 4.5V3.2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.3M5 4.5l.6 8a1 1 0 0 0 1 .95h2.8a1 1 0 0 0 1-.95l.6-8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
