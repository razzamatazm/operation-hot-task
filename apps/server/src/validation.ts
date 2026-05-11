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
  folderName: z.string().min(1).optional(),
  loanName: z.string().min(1).optional(),
  taskType: z.enum(["LOI", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]),
  dueAt: z.string().datetime().optional(),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "returnDate must be YYYY-MM-DD").optional(),
  urgency: z.enum(["GREEN", "YELLOW", "ORANGE", "RED"]).optional(),
  points: z.number().int().min(0).max(5).optional(),
  notes: z.string().min(1),
  humperdinkLink: humperdinkLinkSchema,
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

export const updatePointsSchema = z.object({
  points: z.number().int().min(0).max(5)
});

export const transitionSchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED", "CANCELLED", "ARCHIVED"]),
  reviewNotes: z.string().min(1).max(1000).optional()
});

export const reviewNoteSchema = z.object({
  text: z.string().min(1).max(1000)
});
