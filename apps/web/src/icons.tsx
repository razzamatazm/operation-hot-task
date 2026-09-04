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

/* The padlock on the locked task type, and the (i) beside the form footer's
   one-line notice. Both sit next to text that already says the whole thing, so
   like the two above they are decorative and hidden from a screen reader. */
export const LockIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <rect x="3" y="7" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5.6 7V4.9a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const InfoIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 5.1h.01M8 7.4v3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
