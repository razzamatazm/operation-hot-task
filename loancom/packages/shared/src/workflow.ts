import type { RequestStatus, UrgencyLevel, UserRole, VoteKind } from './types.js';

export interface CurrentVote {
  ownerUserId: string;
  vote: VoteKind;
}

export interface ComputeStatusInput {
  votes: CurrentVote[];
  requiredApprovals: number;
  closedAt?: string | null;
  withdrawnAt?: string | null;
}

/**
 * Status is derived from the set of current owner votes. Denial is never
 * terminal — there is always room to negotiate. The only terminal states are
 * WITHDRAWN (submitter or admin withdraws) and CLOSED (auto/manual close after
 * an APPROVED outcome).
 */
export function computeStatus(input: ComputeStatusInput): RequestStatus {
  if (input.withdrawnAt) return 'WITHDRAWN';
  if (input.closedAt) return 'CLOSED';

  const approves = input.votes.filter((v) => v.vote === 'APPROVE').length;
  const denies = input.votes.filter((v) => v.vote === 'DENY').length;
  const clarifications = input.votes.filter((v) => v.vote === 'NEEDS_CLARIFICATION').length;

  if (clarifications > 0) return 'NEEDS_CLARIFICATION';
  if (approves >= input.requiredApprovals) return 'APPROVED';
  if (denies > 0) return 'NEGOTIATING';
  if (approves > 0) return 'PARTIALLY_APPROVED';
  return 'IN_REVIEW';
}

export function isReasonRequired(vote: VoteKind): boolean {
  return vote === 'DENY' || vote === 'NEEDS_CLARIFICATION';
}

export interface PermissionContext {
  user: { id: string; role: UserRole };
  request: {
    submittedByUserId: string;
    status: RequestStatus;
  };
}

export function canVote(ctx: PermissionContext): boolean {
  if (ctx.user.role !== 'OWNER') return false;
  return ctx.request.status !== 'CLOSED' && ctx.request.status !== 'WITHDRAWN';
}

export function canComment(ctx: PermissionContext): boolean {
  return ctx.request.status !== 'CLOSED' && ctx.request.status !== 'WITHDRAWN';
}

export function canWithdraw(ctx: PermissionContext): boolean {
  if (ctx.request.status === 'CLOSED' || ctx.request.status === 'WITHDRAWN') return false;
  return ctx.user.id === ctx.request.submittedByUserId || ctx.user.role === 'ADMIN';
}

export function canOverrideQuorum(ctx: PermissionContext): boolean {
  return ctx.user.role === 'OWNER' || ctx.user.role === 'ADMIN';
}

const URGENCY_HOURS: Record<UrgencyLevel, number> = {
  RED: 0,
  ORANGE: 1,
  YELLOW: 8,
  GREEN: 24,
};

export function computeDueAt(submittedAt: Date, urgency: UrgencyLevel): Date {
  const due = new Date(submittedAt);
  due.setHours(due.getHours() + URGENCY_HOURS[urgency]);
  return due;
}

export function isOverdue(dueAt: Date | null, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  return now.getTime() > dueAt.getTime();
}

export interface VoteSummary {
  ownerUserId: string;
  ownerName: string;
  vote: VoteKind | null;
  votedAt: string | null;
}

export function summarizeVotes(
  owners: Array<{ id: string; displayName: string }>,
  current: Array<{ ownerUserId: string; vote: VoteKind; votedAt: string }>,
): VoteSummary[] {
  const byOwner = new Map(current.map((v) => [v.ownerUserId, v]));
  return owners.map((o) => {
    const v = byOwner.get(o.id);
    return {
      ownerUserId: o.id,
      ownerName: o.displayName,
      vote: v?.vote ?? null,
      votedAt: v?.votedAt ?? null,
    };
  });
}
