import { z } from "zod";

export const createTaskSchema = z.object({
  folderName: z.string().min(1).optional(),
  loanName: z.string().min(1).optional(),
  taskType: z.enum(["LOI", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]),
  dueAt: z.string().datetime().optional(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "returnDate must be YYYY-MM-DD").optional(),
  urgency: z.enum(["GREEN", "YELLOW", "ORANGE", "RED"]).optional(),
  notes: z.string().min(1),
  humperdinkLink: z.string().url().optional().or(z.literal("")),
  serverLocation: z.string().optional()
}).superRefine((value, ctx) => {
  const hasFolderName = Boolean(value.folderName?.trim());
  const hasLoanName = Boolean(value.loanName?.trim());
  const hasServerLocation = Boolean(value.serverLocation?.trim());
  if (!hasFolderName && !hasLoanName && !hasServerLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "folderName, loanName, or serverLocation is required"
    });
  }

  if (value.taskType === "OOO") {
    if (!value.returnDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "returnDate is required for OOO tasks"
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
  } else if (value.returnDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "returnDate is only allowed for OOO tasks"
    });
  }
});

export const transitionSchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED", "CANCELLED", "ARCHIVED"]),
  reviewNotes: z.string().min(1).max(1000).optional()
});

export const reviewNoteSchema = z.object({
  text: z.string().min(1).max(1000)
});
