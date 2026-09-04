import { isTaskParty } from "./parties.js";
import { CLOSED_STATUSES, LoanTask, UserIdentity } from "./types.js";

/* Who may change a Loan's name or Humperdink link (#266, ADR-0008 rule 5).

   ADR-0001 opened this to any authenticated user, on the same trust that lets
   anyone file a task. That was the wrong comparison. Filing a task adds a row
   of your own; renaming a loan rewrites the row on every task pointing at it,
   including finished ones and including other people's. ADR-0008 rule 5 names
   the narrower answer and its consequences section spells it out: only the two
   parties, and only through the task they are a party to.

   So a loan edit is no longer a thing you do to a loan. It is a thing you do
   from a task — the request carries the task id, and this module is the rule
   that judges it. The predicate is `isTaskParty`, the same one that decides who
   may correct an LOI's terms (#263) and who counts as an Observer on the card;
   three surfaces asking one question is exactly the point.

   The strings live here, beside the rule, for the reason `assignRefusalMessage`
   does: the server throws them and the web renders them, and two copies of a
   sentence about a rule is how the two surfaces end up describing different
   rules. */

/* Why this person can't edit this loan from this task, or `undefined` when they
   can. Worded like `amendRefusal`, which is the same shape of answer about the
   neighbouring fields on the same form.

   Takes only what it judges, so the server can ask it of a stored task and the
   web of the one in its list without either widening to the other's shape. */
export const loanEditRefusal = (
  task: Pick<LoanTask, "createdBy" | "assignee" | "status">,
  user: Pick<UserIdentity, "id">
): string | undefined => {
  if (!isTaskParty(task, user)) {
    return "Only the person who requested this task or the person working it can change its loan's name or link";
  }
  /* ADR-0008 rule 6, unchanged from ADR-0006 and applied here for the same
     reason: a closed task is a record of what happened, and reopening is the
     route for a genuine late correction. Being a party to it is not a way
     back in. */
  if (CLOSED_STATUSES.includes(task.status)) {
    return "A loan can't be changed from a closed task — reopen it first";
  }
  return undefined;
};

export const canEditLoanFrom = (
  task: Pick<LoanTask, "createdBy" | "assignee" | "status">,
  user: Pick<UserIdentity, "id">
): boolean => loanEditRefusal(task, user) === undefined;

/* The two refusals that are about the request rather than the person.

   A loan edit with no task behind it has nobody to check, so it is refused
   before the rule above ever runs — there is no "any authenticated user" path
   left to fall back to. And a task id belonging to a different loan is the same
   refusal wearing a disguise: being a party to task A confers nothing over the
   loan on task B. */
export const LOAN_EDIT_NEEDS_TASK =
  "A loan is edited from one of its tasks, so the task has to be named";

export const LOAN_EDIT_WRONG_LOAN = "That task isn't on this loan";

/* One thing this rule does NOT cover, said out loud rather than left to be
   discovered: the loan on the far side of a merge. A confirmed link edit folds a
   SECOND loan in, and the check above is made against the loan being edited, so
   a party to that one can still absorb tasks belonging to people they are
   nobody to. It is not a regression — before this, either side was open to
   anyone, and unannounced (#265 added the dialog that at least names the other
   loan). Narrowing it needs an answer nobody has given: a loan has many tasks
   and many parties, so "a party to the absorbed loan" would have to mean a party
   to any ONE of its tasks, and a loan with no tasks has nobody at all. Left open
   deliberately; do not invent a rule for it here. */
