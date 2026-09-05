import { oooDatesOutOfOrder } from "@loan-tasks/shared";
import { z } from "zod";

const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:/i;

export const normalizeHumperdinkLink = (raw: string): string | null => {
  const value = raw.trim();
  if (value.length === 0) return "";
  const candidate = SCHEME_PREFIX_RE.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
};

const humperdinkLinkSchema = z
  .string()
  .transform((value, ctx) => {
    const normalized = normalizeHumperdinkLink(value);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "humperdinkLink must be an http(s) URL"
      });
      return z.NEVER;
    }
    return normalized;
  })
  .optional();

export const createTaskSchema = z.object({
  loanId: z.string().min(1).optional(),
  folderName: z.string().min(1).optional(),
  loanName: z.string().min(1).optional(),
  taskType: z.enum(["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]),
  dueAt: z.string().datetime().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD").optional(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "returnDate must be YYYY-MM-DD").optional(),
  urgency: z.enum(["GREEN", "YELLOW", "ORANGE", "RED"]).optional(),
  points: z.number().int().min(0).max(5).optional(),
  notes: z.string().min(1),
  humperdinkLink: humperdinkLinkSchema,
  serverLocation: z.string().optional(),
  // FRAUD only (#69): outstanding items the creator seeds at creation. Optional
  // (zero is fine). Ignored server-side for non-FRAUD task types.
  initialItems: z.array(z.object({ text: z.string().min(1).max(500) })).optional(),
  // Handoff at creation (ADR-0002): the task is born assigned to this user and
  // lands CLAIMED. The route resolves the id and checks recipient eligibility.
  assigneeUserId: z.string().min(1).optional(),
  assigneeNote: z.string().max(280).optional()
}).superRefine((value, ctx) => {
  const hasFolderName = Boolean(value.folderName?.trim());
  const hasLoanName = Boolean(value.loanName?.trim());
  const hasServerLocation = Boolean(value.serverLocation?.trim());
  const hasLoanId = Boolean(value.loanId?.trim());
  if (!hasFolderName && !hasLoanName && !hasServerLocation && !hasLoanId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "folderName, loanName, serverLocation, or loanId is required"
    });
  }

  if (value.taskType === "OOO") {
    if (!value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startDate is required for OOO tasks"
      });
    }
    if (!value.returnDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "returnDate is required for OOO tasks"
      });
    }
    // The range rule is the shared one the edit path asks too (#264), not a
    // third copy of it: filing and correcting must agree on what a valid pair
    // of dates is. The sentence stays this schema's own — it speaks in field
    // names like the messages either side of it, and neither #261 nor #264
    // asked to reword what somebody filing a backwards vacation sees.
    if (value.startDate && value.returnDate && oooDatesOutOfOrder(value.startDate, value.returnDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startDate must be on or before returnDate"
      });
    }
    if (value.urgency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "urgency is not allowed for OOO tasks"
      });
    }
    if (value.dueAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dueAt is not allowed for OOO tasks"
      });
    }
    if (value.humperdinkLink) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "humperdinkLink is not allowed for OOO tasks"
      });
    }
  } else {
    if (value.returnDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "returnDate is only allowed for OOO tasks"
      });
    }
    if (value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startDate is only allowed for OOO tasks"
      });
    }
  }
});

export const createLoanSchema = z.object({
  name: z.string().min(1),
  humperdinkLink: humperdinkLinkSchema
});

/* Loan edit: at least one editable field must be present. An empty-string
   link explicitly clears it.

   `confirmMerge` is an answer, not a field: it says the person has been told
   this link belongs to another loan and has agreed to fold the two together
   (#265, ADR-0008 rule 7). It is not one of the fields the refine below counts,
   because on its own it changes nothing.

   `taskId` is required (#266, ADR-0008 rule 5): a loan edit is something one of
   the loan's two parties does from the task they are a party to, so a request
   naming no task names nobody to check. Typed optional here and enforced in the
   route rather than by the schema, because a missing one is a refusal a person
   should be able to read — zod's own message for it arrives as a JSON dump, and
   the route can answer with `LOAN_EDIT_NEEDS_TASK`, the sentence that names the
   rule. It is not one of the fields the refine below counts either: it says who
   is asking, not what to change. */
export const updateLoanSchema = z
  .object({
    taskId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    humperdinkLink: humperdinkLinkSchema,
    confirmMerge: z.boolean().optional()
  })
  .refine((value) => value.name !== undefined || value.humperdinkLink !== undefined, {
    message: "Provide a name and/or humperdinkLink to update"
  });

export const updatePointsSchema = z.object({
  points: z.number().int().min(0).max(5)
});

/* Amending the ask (ADR-0006, extended by ADR-0008 rule 8). Four focused
   schemas, counting the points one above — one per operation, each accepting
   exactly its own field. There is deliberately no `dueAt` anywhere: the
   deadline is derived from urgency server-side and is never an input. */
export const amendNotesSchema = z.object({
  notes: z.string().min(1)
});

export const amendUrgencySchema = z.object({
  urgency: z.enum(["GREEN", "YELLOW", "ORANGE", "RED"])
});

/* An out-of-office task's description (#262). Its own schema and its own route
   for the same reason the two above have theirs: the URL names the field, so
   the rule that refuses is the rule the route is about. Non-OOO folder names
   are never accepted here — they belong to the shared Loan record. */
export const amendFolderNameSchema = z.object({
  folderName: z.string().min(1)
});

/* An OOO task's two dates (#264). Both required, because they are one range
   and a start is only valid against the return it is checked with — sending
   half of it would validate against a value the caller never saw.

   Shape only. Whether the range makes sense is `oooDatesOutOfOrder` in shared,
   which filing asks the same question of, and nothing here rejects a date in
   the past: correcting a vacation that has already ended is the case the edit
   exists for (ADR-0008 rule 8). */
export const amendOooDatesSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "returnDate must be YYYY-MM-DD")
});

export const transitionSchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED", "CANCELLED", "ARCHIVED"]),
  reviewNotes: z.string().min(1).max(1000).optional()
});

/* Handoff (ADR-0002). The note is capped at 280 like the share popover's — it
   is a one-line "here, this is yours", not a work item. */
export const assignSchema = z.object({
  assigneeUserId: z.string().min(1),
  note: z.string().max(280).optional()
});

export const reviewNoteSchema = z.object({
  text: z.string().min(1).max(1000)
});

/* Correcting a message you posted (#287, ADR-0009). Same field and the same
   ceiling as posting one — an edit that could exceed the length a message may
   be posted at would be a second, wider door onto the same field.

   `min(1)` catches an empty string here, but it is not where "an edit may not
   empty a message" lives: a body of `"   "` clears this schema and is refused
   by the shared `isEmptyMessageText` in the service, which is the one rule the
   Save button reads too. This schema says the payload has a text field; the
   service says whether it says anything. */
export const messageEditSchema = z.object({
  text: z.string().min(1).max(1000)
});

/* FRAUD structured checklist (#44) — one focused schema per atomic op. */
export const checklistItemTextSchema = z.object({
  text: z.string().min(1).max(500)
});

export const checklistItemCheckedSchema = z.object({
  checked: z.boolean(),
  note: z.string().max(1000).optional()
});

/* One note schema for one note endpoint: the field the text lands in is the
   actor's seat's, derived server-side, so the payload never names it. */
export const checklistItemNoteSchema = z.object({
  note: z.string().max(1000)
});
