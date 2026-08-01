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
  initialItems: z.array(z.object({ text: z.string().min(1).max(500) })).optional()
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
    if (value.startDate && value.returnDate && value.startDate > value.returnDate) {
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
   link explicitly clears it. */
export const updateLoanSchema = z
  .object({
    name: z.string().min(1).optional(),
    humperdinkLink: humperdinkLinkSchema
  })
  .refine((value) => value.name !== undefined || value.humperdinkLink !== undefined, {
    message: "Provide a name and/or humperdinkLink to update"
  });

export const updatePointsSchema = z.object({
  points: z.number().int().min(0).max(5)
});

export const transitionSchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED", "CANCELLED", "ARCHIVED"]),
  reviewNotes: z.string().min(1).max(1000).optional()
});

export const reviewNoteSchema = z.object({
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

export const checklistItemNoteSchema = z.object({
  note: z.string().max(1000)
});

export const checklistItemCheckerNoteSchema = z.object({
  checkerNote: z.string().max(1000)
});
