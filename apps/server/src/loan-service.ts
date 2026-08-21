import {
  CreateLoanInput,
  Loan,
  LoanMatch,
  LoanTask,
  UpdateLoanInput,
  clusterLoanNames,
  findLoanForCreate,
  normalizeLinkKey,
  searchLoans
} from "@loan-tasks/shared";
import { v4 as uuid } from "uuid";
import { LoanStore, TaskStore } from "./store.js";
import { SseHub } from "./sse.js";

export interface LoanMergeNotice {
  intoLoanId: string;
  intoLoanName: string;
  mergedName: string;
}

/* Owns the Loan entity (ADR-0001): CRUD, the create-time dedupe/link, the
   canonical-link auto-merge, and propagation of name/link edits to every
   linked task (the "live reference" the ADR requires). */
export class LoanService {
  constructor(
    private readonly loans: LoanStore,
    private readonly tasks: TaskStore,
    private readonly events: SseHub
  ) {}

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

  async update(loanId: string, input: UpdateLoanInput): Promise<{ loan: Loan; merged?: LoanMergeNotice }> {
    const loan = await this.loans.find(loanId);
    if (!loan) {
      throw new Error("Loan not found");
    }
    const updated = await this.applyUpdate(loan, input);

    // Canonical-key auto-merge: if the new link now collides with another
    // loan, fold this record into the older original.
    const linkKey = normalizeLinkKey(updated.humperdinkLink);
    if (linkKey) {
      const all = await this.loans.all();
      const collision = all.find(
        (other) => other.id !== updated.id && normalizeLinkKey(other.humperdinkLink) === linkKey
      );
      if (collision) {
        const [original, duplicate] =
          collision.createdAt <= updated.createdAt ? [collision, updated] : [updated, collision];
        const merged = await this.mergeInto(original, duplicate);
        return {
          loan: merged,
          merged: { intoLoanId: original.id, intoLoanName: original.name, mergedName: duplicate.name }
        };
      }
    }
    return { loan: updated };
  }

  /* Apply name/link changes to a loan and propagate to every linked task. */
  private async applyUpdate(loan: Loan, input: UpdateLoanInput): Promise<Loan> {
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
    await this.propagateToTasks(next);
    return next;
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
        }
      }
    }
    return survivor;
  }

  /* Push a loan's current name/link onto every task that references it, so
     the denormalized display cache stays consistent with the live loan. */
  private async propagateToTasks(loan: Loan): Promise<void> {
    const tasks = await this.tasks.allTasks();
    for (const task of tasks) {
      if (task.loanId !== loan.id) continue;
      const next = await this.tasks.updateTask(task.id, (current) => ({
        task: this.applyLoanToTask(current, loan)
      }));
      if (next) {
        this.events.broadcast({ type: "task.changed", payload: next });
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
