import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { computeStatus, summarizeVotes } from '@loancom/shared';
import type { ApprovalRequestWithContext, RequestStatus, UserIdentity, VoteSummary } from '@loancom/shared';
import { db } from './db/client.js';
import { approvalRequests, attachments, loans, ownerVotes, users } from './db/schema.js';

export interface FeedItem {
  id: string;
  title: string;
  requestType: string;
  intakeSource: string;
  urgency: string;
  submittedAt: string;
  dueAt: string | null;
  status: RequestStatus;
  loan: { id: string; externalId: string; borrowerName: string };
  submittedBy: Pick<UserIdentity, 'id' | 'displayName'>;
  voteSummary: VoteSummary[];
}

function loadOwners(): Array<{ id: string; displayName: string }> {
  const rows = db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.role, 'OWNER'))
    .all();
  return rows;
}

function loadCurrentVotesByRequest(requestIds: string[]): Map<string, Array<{ ownerUserId: string; vote: 'APPROVE' | 'DENY' | 'NEEDS_CLARIFICATION'; votedAt: string }>> {
  const out = new Map<string, Array<{ ownerUserId: string; vote: 'APPROVE' | 'DENY' | 'NEEDS_CLARIFICATION'; votedAt: string }>>();
  if (requestIds.length === 0) return out;
  const rows = db
    .select({
      requestId: ownerVotes.requestId,
      ownerUserId: ownerVotes.ownerUserId,
      vote: ownerVotes.vote,
      votedAt: ownerVotes.votedAt,
    })
    .from(ownerVotes)
    .where(isNull(ownerVotes.supersededAt))
    .all();
  for (const r of rows) {
    if (!requestIds.includes(r.requestId)) continue;
    const list = out.get(r.requestId) ?? [];
    list.push({ ownerUserId: r.ownerUserId, vote: r.vote, votedAt: r.votedAt });
    out.set(r.requestId, list);
  }
  return out;
}

export function listFeed(filter?: { status?: RequestStatus | 'OPEN' }): FeedItem[] {
  const requestRows = db
    .select()
    .from(approvalRequests)
    .orderBy(desc(approvalRequests.submittedAt))
    .all();

  const ids = requestRows.map((r) => r.id);
  const votesByRequest = loadCurrentVotesByRequest(ids);
  const owners = loadOwners();

  const loanRows = db.select().from(loans).all();
  const loanById = new Map(loanRows.map((l) => [l.id, l]));

  const userRows = db.select().from(users).all();
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const items: FeedItem[] = requestRows.map((r) => {
    const currentVotes = votesByRequest.get(r.id) ?? [];
    const status = computeStatus({
      votes: currentVotes,
      requiredApprovals: r.requiredApprovals,
      closedAt: r.closedAt,
      withdrawnAt: r.withdrawnAt,
    });
    const loan = loanById.get(r.loanId)!;
    const submittedBy = userById.get(r.submittedByUserId)!;
    return {
      id: r.id,
      title: r.title,
      requestType: r.requestType,
      intakeSource: r.intakeSource,
      urgency: r.urgency,
      submittedAt: r.submittedAt,
      dueAt: r.dueAt,
      status,
      loan: { id: loan.id, externalId: loan.externalId, borrowerName: loan.borrowerName },
      submittedBy: { id: submittedBy.id, displayName: submittedBy.displayName },
      voteSummary: summarizeVotes(owners, currentVotes),
    };
  });

  if (filter?.status === 'OPEN') {
    return items.filter((i) => i.status !== 'CLOSED' && i.status !== 'WITHDRAWN');
  }
  if (filter?.status) {
    return items.filter((i) => i.status === filter.status);
  }
  return items;
}

export function loadRequest(id: string): ApprovalRequestWithContext | null {
  const r = db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get();
  if (!r) return null;
  const loan = db.select().from(loans).where(eq(loans.id, r.loanId)).get()!;
  const submittedBy = db.select().from(users).where(eq(users.id, r.submittedByUserId)).get()!;
  const voteRows = db
    .select()
    .from(ownerVotes)
    .where(and(eq(ownerVotes.requestId, id), isNull(ownerVotes.supersededAt)))
    .all();
  const attachmentRows = db.select().from(attachments).where(eq(attachments.requestId, id)).all();

  const status = computeStatus({
    votes: voteRows.map((v) => ({ ownerUserId: v.ownerUserId, vote: v.vote })),
    requiredApprovals: r.requiredApprovals,
    closedAt: r.closedAt,
    withdrawnAt: r.withdrawnAt,
  });

  return {
    id: r.id,
    loanId: r.loanId,
    requestType: r.requestType,
    status,
    title: r.title,
    summary: r.summary,
    intakeSource: r.intakeSource,
    submittedByUserId: r.submittedByUserId,
    submittedAt: r.submittedAt,
    dueAt: r.dueAt,
    urgency: r.urgency,
    requiredApprovals: r.requiredApprovals,
    closedAt: r.closedAt,
    withdrawnAt: r.withdrawnAt,
    version: r.version,
    loan: {
      id: loan.id,
      externalId: loan.externalId,
      borrowerName: loan.borrowerName,
      address: loan.address,
      status: loan.status,
      createdAt: loan.createdAt,
    },
    submittedBy: {
      id: submittedBy.id,
      email: submittedBy.email,
      displayName: submittedBy.displayName,
      role: submittedBy.role,
    },
    votes: voteRows.map((v) => ({
      id: v.id,
      requestId: v.requestId,
      ownerUserId: v.ownerUserId,
      vote: v.vote,
      reason: v.reason,
      votedAt: v.votedAt,
      supersededAt: v.supersededAt,
    })),
    attachments: attachmentRows.map((a) => ({
      id: a.id,
      requestId: a.requestId,
      commentId: a.commentId,
      fileName: a.fileName,
      kind: a.kind,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      storagePath: a.storagePath,
      uploadedByUserId: a.uploadedByUserId,
      createdAt: a.createdAt,
    })),
  };
}

export function listLoans(query?: string): Array<{ id: string; externalId: string; borrowerName: string; address: string | null }> {
  const rows = db.select().from(loans).orderBy(asc(loans.borrowerName)).all();
  if (!query) return rows.map((l) => ({ id: l.id, externalId: l.externalId, borrowerName: l.borrowerName, address: l.address }));
  const q = query.toLowerCase();
  return rows
    .filter((l) => l.borrowerName.toLowerCase().includes(q) || l.externalId.toLowerCase().includes(q))
    .map((l) => ({ id: l.id, externalId: l.externalId, borrowerName: l.borrowerName, address: l.address }));
}

export function listUsers(): UserIdentity[] {
  const rows = db.select().from(users).orderBy(asc(users.role), asc(users.displayName)).all();
  return rows.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role }));
}

export function ownerCount(): number {
  const row = db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users WHERE role = 'OWNER'`);
  return row?.c ?? 0;
}
