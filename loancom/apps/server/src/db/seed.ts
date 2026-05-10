import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { computeDueAt } from '@loancom/shared';
import type { RequestType, UrgencyLevel, VoteKind } from '@loancom/shared';
import { db } from './client.js';
import {
  approvalRequests,
  comments,
  loans,
  ownerVotes,
  users,
} from './schema.js';

interface SeedOwner {
  id: string;
  email: string;
  displayName: string;
}
interface SeedOfficer extends SeedOwner {}
interface SeedLoan {
  id: string;
  externalId: string;
  borrowerName: string;
  address: string;
}

interface SeedRequest {
  loanExternalId: string;
  type: RequestType;
  title: string;
  summary: string;
  submitter: 'avery' | 'brooke' | 'cal' | 'dee';
  urgency: UrgencyLevel;
  intake: 'WEB' | 'EMAIL' | 'INTEGRATION_API';
  hoursAgo: number;
  votes?: Array<{ owner: 'hank' | 'mort'; vote: VoteKind; reason?: string; minutesAgo: number }>;
  comments?: Array<{ author: 'avery' | 'brooke' | 'cal' | 'dee' | 'hank' | 'mort'; body: string; minutesAgo: number }>;
  requiredApprovals?: number;
}

const OWNERS: SeedOwner[] = [
  { id: 'usr_hank', email: 'hank@loancom.test', displayName: 'Hank Halloran' },
  { id: 'usr_mort', email: 'mort@loancom.test', displayName: 'Mort Mendelsohn' },
];

const OFFICERS: Record<string, SeedOfficer> = {
  avery: { id: 'usr_avery', email: 'avery@loancom.test', displayName: 'Avery Park' },
  brooke: { id: 'usr_brooke', email: 'brooke@loancom.test', displayName: 'Brooke Ramos' },
  cal: { id: 'usr_cal', email: 'cal@loancom.test', displayName: 'Cal Tanaka' },
  dee: { id: 'usr_dee', email: 'dee@loancom.test', displayName: 'Dee Washington' },
};

const SEED_LOANS: SeedLoan[] = [
  { id: 'loan_001', externalId: 'L-2026-0142', borrowerName: 'Cypress Holdings LLC', address: '418 Mariposa Ln, Reno NV' },
  { id: 'loan_002', externalId: 'L-2026-0151', borrowerName: 'Greenline Partners', address: '2120 Ash Way, Boise ID' },
  { id: 'loan_003', externalId: 'L-2026-0158', borrowerName: 'Sunset Real Estate Trust', address: '83 Highland Ct, Phoenix AZ' },
  { id: 'loan_004', externalId: 'L-2026-0162', borrowerName: 'Northshore Capital', address: '1107 Lakeview Dr, Spokane WA' },
  { id: 'loan_005', externalId: 'L-2026-0167', borrowerName: 'Marlowe Industrial', address: '88 Foundry Rd, Tacoma WA' },
  { id: 'loan_006', externalId: 'L-2026-0173', borrowerName: 'Hilltop Family Trust', address: '5 Ridge Ave, Bend OR' },
];

const SEED_REQUESTS: SeedRequest[] = [
  {
    loanExternalId: 'L-2026-0142',
    type: 'LOI',
    title: 'LOI approval — Cypress Holdings',
    summary:
      '<p>Sponsor requests approval to issue an LOI for a 24-month bridge at 9.75% on a 65% LTV. See attached LOI draft.</p>',
    submitter: 'avery',
    urgency: 'YELLOW',
    intake: 'WEB',
    hoursAgo: 2,
  },
  {
    loanExternalId: 'L-2026-0151',
    type: 'VALUE',
    title: 'Valuation approval — Greenline Partners',
    summary:
      '<p>Internal valuation came in at $4.2M against borrower\'s $4.6M ask. Need committee sign-off on accepting at the lower number.</p>',
    submitter: 'brooke',
    urgency: 'ORANGE',
    intake: 'EMAIL',
    hoursAgo: 5,
    votes: [{ owner: 'hank', vote: 'APPROVE', minutesAgo: 90 }],
    comments: [
      { author: 'hank', body: 'Comps look fine to me. Mort, your call.', minutesAgo: 88 },
    ],
  },
  {
    loanExternalId: 'L-2026-0158',
    type: 'TERMS',
    title: 'Terms negotiation — Sunset Real Estate Trust',
    summary:
      '<p>Sponsor pushing for an interest reserve carve-out on month 1-3. Recommend declining; competing offers without one.</p>',
    submitter: 'cal',
    urgency: 'YELLOW',
    intake: 'WEB',
    hoursAgo: 8,
    votes: [
      { owner: 'hank', vote: 'APPROVE', minutesAgo: 200 },
      { owner: 'mort', vote: 'DENY', reason: 'Reserve carve-out is a non-starter on a stabilized asset.', minutesAgo: 60 },
    ],
    comments: [
      { author: 'mort', body: 'Cal, can we counter at 1 month only?', minutesAgo: 55 },
      { author: 'cal', body: 'Sponsor open to that — drafting now.', minutesAgo: 30 },
    ],
  },
  {
    loanExternalId: 'L-2026-0162',
    type: 'DOC_REDLINE',
    title: 'Redlines on Northshore loan agreement',
    summary:
      '<p>Counsel sent over redlined loan agreement. Highlighting changes to Section 7 (covenants) and Section 11 (default).</p>',
    submitter: 'dee',
    urgency: 'GREEN',
    intake: 'EMAIL',
    hoursAgo: 26,
    votes: [
      { owner: 'hank', vote: 'NEEDS_CLARIFICATION', reason: 'What is the practical effect of the Section 11 change?', minutesAgo: 600 },
    ],
    comments: [
      { author: 'dee', body: 'Re: Section 11 — counsel says it widens the cure window from 10 to 30 days. Customary on this asset class.', minutesAgo: 240 },
    ],
  },
  {
    loanExternalId: 'L-2026-0167',
    type: 'FUNDING',
    title: 'Approval to fund — Marlowe Industrial',
    summary:
      '<p>All conditions cleared. Wire instructions verified. Requesting committee approval to release $2.85M.</p>',
    submitter: 'avery',
    urgency: 'RED',
    intake: 'INTEGRATION_API',
    hoursAgo: 1,
    votes: [
      { owner: 'hank', vote: 'APPROVE', minutesAgo: 30 },
      { owner: 'mort', vote: 'APPROVE', minutesAgo: 15 },
    ],
  },
  {
    loanExternalId: 'L-2026-0173',
    type: 'GENERIC_QUESTION',
    title: 'Servicing question — Hilltop forbearance request',
    summary:
      '<p>Borrower experiencing temporary cash crunch (lost a tenant). Asking for 60-day P&amp;I forbearance. How would committee like to respond?</p>',
    submitter: 'brooke',
    urgency: 'YELLOW',
    intake: 'WEB',
    hoursAgo: 14,
  },
];

function isoMinutesAgo(min: number): string {
  const d = new Date(Date.now() - min * 60_000);
  return d.toISOString();
}

function isoHoursAgo(hr: number): string {
  return isoMinutesAgo(hr * 60);
}

export function isSeeded(): boolean {
  const row = db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users`);
  return (row?.c ?? 0) > 0;
}

export function seed(): void {
  if (isSeeded()) return;
  console.log('[seed] populating demo data');

  db.insert(users)
    .values([
      ...OWNERS.map((o) => ({ ...o, role: 'OWNER' as const })),
      ...Object.values(OFFICERS).map((o) => ({ ...o, role: 'OFFICER' as const })),
    ])
    .run();

  db.insert(loans).values(SEED_LOANS).run();

  for (const req of SEED_REQUESTS) {
    const loan = SEED_LOANS.find((l) => l.externalId === req.loanExternalId);
    if (!loan) throw new Error(`seed: missing loan ${req.loanExternalId}`);
    const submitter = OFFICERS[req.submitter];
    const requestId = `req_${nanoid(10)}`;
    const submittedAt = isoHoursAgo(req.hoursAgo);
    const dueAt = computeDueAt(new Date(submittedAt), req.urgency).toISOString();

    db.insert(approvalRequests)
      .values({
        id: requestId,
        loanId: loan.id,
        requestType: req.type,
        title: req.title,
        summary: req.summary,
        intakeSource: req.intake,
        submittedByUserId: submitter.id,
        submittedAt,
        dueAt,
        urgency: req.urgency,
        requiredApprovals: req.requiredApprovals ?? 2,
      })
      .run();

    if (req.votes) {
      for (const v of req.votes) {
        const ownerId = v.owner === 'hank' ? 'usr_hank' : 'usr_mort';
        db.insert(ownerVotes)
          .values({
            id: `vote_${nanoid(10)}`,
            requestId,
            ownerUserId: ownerId,
            vote: v.vote,
            reason: v.reason ?? null,
            votedAt: isoMinutesAgo(v.minutesAgo),
          })
          .run();
      }
    }
    if (req.comments) {
      for (const c of req.comments) {
        const author =
          c.author === 'hank' ? OWNERS[0] :
          c.author === 'mort' ? OWNERS[1] :
          OFFICERS[c.author];
        db.insert(comments)
          .values({
            id: `cmt_${nanoid(10)}`,
            requestId,
            loanId: loan.id,
            authorUserId: author.id,
            body: c.body,
            createdAt: isoMinutesAgo(c.minutesAgo),
          })
          .run();
      }
    }
  }

  console.log('[seed] done');
}
