/* Metrics and Admin, the two admin-only pages, and the ways in and out (#438).

   They used to be tabs on an app bar above the board, Tasks / Metrics / Admin,
   which only an admin ever saw. Production has no app bar now. The way in is
   the last section of the app menu, drawn for an admin only; the way out is a
   Back to Tasks link at the top of each page, which carries no menu or other
   header controls. Going from Metrics to Admin means back to Tasks first.

   Which page shows is App's `activeTab`; both pieces here only ask for a
   change. */

export type AppPage = "metrics" | "admin";

const PAGES: ReadonlyArray<{ page: AppPage; label: string }> = [
  { page: "metrics", label: "Metrics" },
  { page: "admin", label: "Admin" }
];

/* The menu's last group, under the same mono label as the others. The two
   buttons share one row, each dressed as Collapse All Tasks is. The menu closes
   itself before asking, so this knows nothing about it being open. */
export const AdminMenuSection = ({ onOpenPage }: { onOpenPage: (page: AppPage) => void }) => (
  <div className="app-menu-group app-menu-admin" role="group" aria-label="Admin">
    <span className="app-menu-label">Admin</span>
    <div className="app-menu-admin-row">
      {PAGES.map(({ page, label }) => (
        <button key={page} type="button" role="menuitem" className="app-menu-action" onClick={() => onOpenPage(page)}>
          {label}
        </button>
      ))}
    </div>
  </div>
);

/* A button that reads as a link: it changes the view, not a task. The arrow is
   decoration, so a screen reader hears only the words. */
export const BackToTasks = ({ onBack }: { onBack: () => void }) => (
  <button type="button" className="back-to-tasks" onClick={onBack}>
    <span aria-hidden="true">← </span>Back to Tasks
  </button>
);
