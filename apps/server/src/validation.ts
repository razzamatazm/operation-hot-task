import { z } from "zod";

export const createTaskSchema = z.object({
  loanName: z.string().min(1),
  taskType: z.enum(["LOI", "VALUE", "FRAUD", "LOAN_DOCS"]),
  dueAt: z.string().datetime().optional(),
  urgency: z.enum(["GREEN", "YELLOW", "RED"]).optional(),
  notes: z.string().min(1),
  humperdinkLink: z.string().url().optional().or(z.literal("")),
  serverLocation: z.string().optional()
});

export const transitionSchema = z.object({
  status: z.enum(["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED", "CANCELLED", "ARCHIVED"])
});
