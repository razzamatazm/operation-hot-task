import {
  CreateLoanInput,
  Loan,
  LoanMatch,
  LoanTask,
  TaskHistoryEvent,
  UpdateLoanInput,
  UserIdentity,
  clusterLoanNames,
  findLoanForCreate,
  normalizeLinkKey,
  searchLoans
} from "@loan-tasks/shared";
import { v4 as uuid } from "uuid";
import { LoanStore, TaskStore } from "./store.js";
import { SseHub } from "./sse.js";

/* Which of a loan's two displayed fields an edit moved, and what each said
   either side of it — the "both values" ADR-0008 rule 9 asks every history row
   to carry. Absent means that field did not move. */
interface LoanFieldChanges {
  name?: { from: string; to: string };
  link?: { from: string; to: string };
}

export interface LoanMergeNotice {
  intoLoanId: string;
  intoLoanName: string;
  mergedName: string;
}

/* A link edit that would fold this loan into another one (#262, ADR-0008
   rule 7). Editing a Humperdink link used to merge the two records on the spot;
   absorbing another loan's tasks is too large a consequence to fall out of
   fixing a URL unannounced, so the edit is refused instead and **neither record
   changes**.

   It names the other loan, because "that link is taken" without saying by what
   leaves the person with nowhere to go. Its own error type rather than a bare
   `Error` so the route can answer 409 rather than the blanket 400 — a refusal
   about the state of another record is not a malformed request.

   Since #265 the refusal is a QUESTION rather than a dead end: the client shows
   it as "merge with <that loan>?", and a yes re-sends the identical change with
   `confirmMerge`, which lands on the merge below. Nothing here changed to make
   that work — the refusal already carried everything the question needs.

   Merges at task CREATION are untouched: `create`/`resolveForTask` fold a new
   record into an existing one through `findLoanForCreate`, which is the dedupe
   that stops duplicates being minted in the first place and absorbs nobody's
   work. This is only about editing a loan that already has tasks on it. */
export class LoanLinkCollisionError extends Error {
  constructor(
    readonly collision: {
      loanId: string;
      loanName: string;
      /* Which of the two records would survive, and which would be absorbed into
         it, decided by the same age rule the merge below uses. The client asks
         about this merge in plain words, and "its tasks move over and its record
         goes away" is a sentence that is only true of one of the two — guessing
         which tells half the people who read it the exact opposite of what will
         happen to their loan. So the answer comes from the code that decides it. */
      survivingName: string;
      absorbedName: string;
    }
  ) {
    super(
      `That Humperdink link is already on "${collision.loanName}". Saving it here would merge the two loans into one.`
    );
    this.name = "LoanLinkCollisionError";
  }
}

/* How far a loan edit is allowed to go. Absent means "refuse a merge", which is
   what every FIRST save sends; `confirmMerge` is set only on the re-send after
   the person has been shown the other loan's name and agreed (#265). The flag
   is an answer, never a default: a caller that sets it unconditionally is back
   to merging unannounced. */
export interface UpdateLoanOptions {
  confirmMerge?: boolean;
  /* Who is making the edit, so every task the edit reaches gets a history row
     naming them and both values (ADR-0008 rule 9, extended to these two fields
     by #262). Optional because the migration and the create-time dedupe write
     loans with no human behind them; where there is nobody to name, no row is
     written rather than one attributed to nobody. */
  actor?: UserIdentity;
}

/* Owns the Loan entity (ADR-0001): CRUD, the create-time dedupe/link, the
   canonical-link merge, and propagation of name/link edits to every linked task
   (the "live reference" the ADR requires).

   The merge fires by itself at creation, where it stops a duplicate record
   being minted, and is refused on an edit unless the caller confirms it (#262,
   ADR-0008 rule 7) — see `LoanLinkCollisionError`. */
export class LoanService {
  /* Asked to correct one task's already-posted Teams cards after a loan edit
     reached it (#280). A callback, not a service reference: the cards live
     behind the notification layer, and a loan service that imported it would
     invert the dependency direction the task service already owns (task service
     → loan service). Injected after construction because the task service is
     built from this one, so there is no moment at which both exist yet.

     Optional throughout. Nothing here waits on it and nothing here fails
     without it: a rename with no corrector wired is exactly today's behaviour,
     which is the right fallback for the migration and the create-time dedupe. */
  private correctTaskCards?: (taskId: string) => void;

  constructor(
    private readonly loans: LoanStore,
    private readonly tasks: TaskStore,
    private readonly events: SseHub
  ) {}

  setCardCorrector(correct: (taskId: string) => void): void {
    this.correctTaskCards = correct;
  }

  /* Fire-and-forget, per task, and never allowed to interrupt the propagation
     loop: the tasks after this one still need their values written, and a card
     is not worth a half-renamed loan. */
  private requestCardCorrection(taskId: string): void {
    if (!this.correctTaskCards) {
      return;
    }
    try {
      this.correctTaskCards(taskId);
    } catch (error) {
      console.error("loan_card_correction_failed", {
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async list(): Promise<Loan[]> {
    return this.loans.all();
  }

  async get(loanId: string): Promise<Loan | undefined> {
    return this.loans.find(loanId);
  }

  async search(query: string, limit = 8): Promise<LoanMatch[]> {
    return searchLoans(query, await this.loans.all(), limit);
  }

  /* Create a standalone Loan (used by the API + as a fallback during task
     creation). Folds into an existing loan when the link or normalized name
     already exists, so we never mint a duplicate. */
  async create(input: CreateLoanInput): Promise<Loan> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Loan name is required");
    }
    const all = await this.loans.all();
    const existing = findLoanForCreate(name, input.humperdinkLink, all);
    if (existing) {
      // Reuse; opportunistically fill in a missing link.
      if (!existing.humperdinkLink && input.humperdinkLink) {
        return this.applyUpdate(existing, { humperdinkLink: input.humperdinkLink });
      }
      return existing;
    }
    const now = new Date().toISOString();
    const loan: Loan = {
      id: uuid(),
      name,
      ...(input.humperdinkLink?.trim() ? { humperdinkLink: input.humperdinkLink.trim() } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.loans.upsert(loan);
    return loan;
  }

  /* Resolve the Loan a new task should link to. Prefers an explicit loanId
     (typeahead selection); otherwise dedupes/creates from the typed name +
     link. Always returns a Loan for non-OOO tasks. */
  async resolveForTask(params: { loanId?: string; name: string; humperdinkLink?: string }): Promise<Loan> {
    if (params.loanId) {
      const found = await this.loans.find(params.loanId);
      if (!found) {
        throw new Error("Linked loan not found");
      }
      // A task can supply a link the loan doesn't have yet — fill it in.
      if (params.humperdinkLink?.trim() && !found.humperdinkLink) {
        return this.applyUpdate(found, { humperdinkLink: params.humperdinkLink });
      }
      return found;
    }
    return this.create({ name: params.name, ...(params.humperdinkLink ? { humperdinkLink: params.humperdinkLink } : {}) });
  }

  /* Edit a loan's name and/or link, which is to say edit what every task on
     that loan displays (ADR-0001's live reference).

     The collision check runs BEFORE anything is written, deliberately. It used
     to run after: the record was updated, the clash noticed, and the two loans
     merged. Refusing after the write would leave the loan renamed and the link
     changed on a save the caller was told failed, so the question "would this
     land on another loan's link" is now answered while both records are still
     untouched. */
  async update(
    loanId: string,
    input: UpdateLoanInput,
    options: UpdateLoanOptions = {}
  ): Promise<{ loan: Loan; merged?: LoanMergeNotice }> {
    const loan = await this.loans.find(loanId);
    if (!loan) {
      throw new Error("Loan not found");
    }

    /* Only a link that is actually MOVING can collide. A rename that leaves the
       link alone is never refused, and neither is re-saving the link the loan
       already has — a loan colliding with itself is the same record. */
    const nextKey = input.humperdinkLink !== undefined ? normalizeLinkKey(input.humperdinkLink) : undefined;
    const collision =
      nextKey && nextKey !== normalizeLinkKey(loan.humperdinkLink)
        ? (await this.loans.all()).find(
            (other) => other.id !== loan.id && normalizeLinkKey(other.humperdinkLink) === nextKey
          )
        : undefined;

    if (collision && !options.confirmMerge) {
      /* The same older-record-wins rule the merge below applies, asked one step
         early so the refusal can say which way this would go. Read off
         `createdAt`, which `applyUpdate` never touches, so asking now and asking
         after the write give the same answer. */
      const edited = { ...loan, name: input.name?.trim() || loan.name };
      const [original, duplicate] = collision.createdAt <= edited.createdAt ? [collision, edited] : [edited, collision];
      throw new LoanLinkCollisionError({
        loanId: collision.id,
        loanName: collision.name,
        // The name as the save WOULD leave it: a rename travelling with the link
        // change is what the person just typed, and it is what they would see.
        survivingName: original.name,
        absorbedName: duplicate.name
      });
    }

    const updated = await this.applyUpdate(loan, input, options.actor);

    // Canonical-key merge: fold this record into the older original. On an edit
    // this is reachable only with an explicit confirmation (#262/#265) — the
    // refusal above is the only other way out.
    if (collision) {
      const [original, duplicate] =
        collision.createdAt <= updated.createdAt ? [collision, updated] : [updated, collision];
      const merged = await this.mergeInto(original, duplicate);
      return {
        loan: merged,
        merged: { intoLoanId: original.id, intoLoanName: original.name, mergedName: duplicate.name }
      };
    }
    return { loan: updated };
  }

  /* Apply name/link changes to a loan and propagate to every linked task. */
  private async applyUpdate(loan: Loan, input: UpdateLoanInput, actor?: UserIdentity): Promise<Loan> {
    const name = input.name?.trim();
    const linkProvided = input.humperdinkLink !== undefined;
    const link = input.humperdinkLink?.trim();
    const next: Loan = {
      ...loan,
      ...(name ? { name } : {}),
      updatedAt: new Date().toISOString()
    };
    if (linkProvided) {
      if (link) {
        next.humperdinkLink = link;
      } else {
        delete next.humperdinkLink;
      }
    }
    await this.loans.upsert(next);
    /* What actually moved, so the history rows below describe the edit rather
       than every field the request happened to carry. Compared against the loan
       as it was a moment ago, which is why this is computed here and not from
       the input. */
    await this.propagateToTasks(next, actor, {
      ...(next.name !== loan.name ? { name: { from: loan.name, to: next.name } } : {}),
      ...(next.humperdinkLink !== loan.humperdinkLink
        ? { link: { from: loan.humperdinkLink ?? "", to: next.humperdinkLink ?? "" } }
        : {})
    });
    return next;
  }

  /* One history row per field that moved, on one task (ADR-0008 rule 9). Written
     onto every task the loan reaches, because a loan edit changes what each of
     them displays and the row is the only place that says who did it and what it
     used to say. */
  private loanEditHistory(taskId: string, actor: UserIdentity, changed: LoanFieldChanges, at: Date): TaskHistoryEvent[] {
    const rows: TaskHistoryEvent[] = [];
    const row = (action: string, detail: string): TaskHistoryEvent => ({
      id: uuid(),
      taskId,
      action,
      detail,
      at: at.toISOString(),
      by: { id: actor.id, displayName: actor.displayName }
    });
    if (changed.name) {
      rows.push(row("TASK_LOAN_NAME_AMENDED", `Loan name changed from "${changed.name.from}" to "${changed.name.to}"`));
    }
    if (changed.link) {
      rows.push(
        row(
          "TASK_LOAN_LINK_AMENDED",
          `Humperdink link changed from "${changed.link.from || "none"}" to "${changed.link.to || "none"}"`
        )
      );
    }
    return rows;
  }

  /* Fold `duplicate` into `original`: repoint tasks, keep the duplicate's name
     as an alias, drop the duplicate record. Returns the surviving loan. */
  private async mergeInto(original: Loan, duplicate: Loan): Promise<Loan> {
    const aliases = new Set([...(original.aliases ?? []), ...(duplicate.aliases ?? [])]);
    if (duplicate.name && duplicate.name !== original.name) {
      aliases.add(duplicate.name);
    }
    const survivor: Loan = {
      ...original,
      ...(aliases.size > 0 ? { aliases: [...aliases] } : {}),
      updatedAt: new Date().toISOString()
    };
    const remaining = (await this.loans.all()).filter((loan) => loan.id !== duplicate.id && loan.id !== original.id);
    await this.loans.replaceAll([...remaining, survivor]);

    // Repoint the duplicate's tasks onto the survivor.
    const tasks = await this.tasks.allTasks();
    for (const task of tasks) {
      if (task.loanId === duplicate.id) {
        // Applied to the task as it is at write time: this loop walks every
        // task on the loan, and the people working them are still ticking
        // checklists while it does (#158).
        const next = await this.tasks.updateTask(task.id, (current) => ({
          task: this.applyLoanToTask(current, survivor)
        }));
        if (next) {
          this.events.broadcast({ type: "task.changed", payload: next });
          // Folding two loans together renames the absorbed loan's tasks as
          // surely as an edit does, so their posted cards are just as stale.
          this.requestCardCorrection(next.id);
        }
      }
    }
    return survivor;
  }

  /* Push a loan's current name/link onto every task that references it, so
     the denormalized display cache stays consistent with the live loan.

     When a human made the edit and something actually moved, each task also
     earns its history rows in the SAME write as the value it is about — passing
     them to `updateTask` rather than appending afterwards is what stops a task
     ending up renamed with no record of who renamed it. */
  private async propagateToTasks(loan: Loan, actor?: UserIdentity, changed?: LoanFieldChanges): Promise<void> {
    const tasks = await this.tasks.allTasks();
    const at = new Date();
    const moved = Boolean(changed && (changed.name || changed.link));
    for (const task of tasks) {
      if (task.loanId !== loan.id) continue;
      const next = await this.tasks.updateTask(task.id, (current) => {
        const event = actor && moved ? this.loanEditHistory(task.id, actor, changed!, at) : undefined;
        return { task: this.applyLoanToTask(current, loan), ...(event ? { event } : {}) };
      });
      if (next) {
        this.events.broadcast({ type: "task.changed", payload: next });
        /* The app now shows the corrected values; the cards already sitting in
           Teams still quote the old ones (#280). Only when something actually
           moved — a propagation that changed nothing has no card to correct. */
        if (moved) {
          this.requestCardCorrection(next.id);
        }
      }
    }
  }

  /* Denormalize a loan's display fields onto a task (does not bump updatedAt,
     so a loan edit doesn't reorder or resurface historical tasks). */
  applyLoanToTask(task: LoanTask, loan: Loan): LoanTask {
    const next: LoanTask = {
      ...task,
      loanId: loan.id,
      folderName: loan.name,
      loanName: loan.name
    };
    if (loan.humperdinkLink) {
      next.humperdinkLink = loan.humperdinkLink;
    } else {
      delete next.humperdinkLink;
    }
    return next;
  }

  /* One-time migration (idempotent): create a Loan per distinct existing
     folderName (fuzzy-deduped) for every non-OOO task lacking a loanId, then
     backfill loanId + denormalized fields onto those tasks. Existing loans are
     reused. Returns counts for logging. */
  async migrateExistingTasks(): Promise<{ loansCreated: number; tasksLinked: number }> {
    const tasks = await this.tasks.allTasks();
    const unlinked = tasks.filter((task) => task.taskType !== "OOO" && !task.loanId);
    if (unlinked.length === 0) {
      return { loansCreated: 0, tasksLinked: 0 };
    }

    const existingLoans = await this.loans.all();
    const clusters = clusterLoanNames(
      unlinked.map((task) => ({
        name: task.folderName,
        ...(task.humperdinkLink ? { humperdinkLink: task.humperdinkLink } : {})
      }))
    );

    let loansCreated = 0;
    const now = new Date().toISOString();
    const newLoans: Loan[] = [];
    // Map every source member-name -> resolved loan.
    const byMemberName = new Map<string, Loan>();

    for (const cluster of clusters) {
      let loan = findLoanForCreate(cluster.name, cluster.humperdinkLink, [...existingLoans, ...newLoans]);
      if (!loan) {
        loan = {
          id: uuid(),
          name: cluster.name,
          ...(cluster.humperdinkLink ? { humperdinkLink: cluster.humperdinkLink } : {}),
          createdAt: now,
          updatedAt: now
        };
        newLoans.push(loan);
        loansCreated += 1;
      }
      for (const member of cluster.members) {
        byMemberName.set(member.trim(), loan);
      }
    }

    if (newLoans.length > 0) {
      await this.loans.replaceAll([...existingLoans, ...newLoans]);
    }

    let tasksLinked = 0;
    for (const task of unlinked) {
      const loan = byMemberName.get(task.folderName.trim());
      if (!loan) continue;
      await this.tasks.updateTask(task.id, (current) => ({ task: this.applyLoanToTask(current, loan) }));
      tasksLinked += 1;
    }

    return { loansCreated, tasksLinked };
  }
}
