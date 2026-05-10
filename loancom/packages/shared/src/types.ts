export const USER_ROLES = ['OWNER', 'OFFICER', 'SERVICING', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const REQUEST_TYPES = [
  'LOI',
  'TERMS',
  'VALUE',
  'FUNDING',
  'DOC_REDLINE',
  'GENERIC_QUESTION',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = [
  'IN_REVIEW',
  'PARTIALLY_APPROVED',
  'NEGOTIATING',
  'NEEDS_CLARIFICATION',
  'APPROVED',
  'WITHDRAWN',
  'CLOSED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const VOTE_KINDS = ['APPROVE', 'DENY', 'NEEDS_CLARIFICATION'] as const;
export type VoteKind = (typeof VOTE_KINDS)[number];

export const INTAKE_SOURCES = ['WEB', 'EMAIL', 'INTEGRATION_API'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export const ATTACHMENT_KINDS = ['PDF', 'IMAGE', 'DOCX', 'EMAIL_BODY', 'OTHER'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const URGENCY_LEVELS = ['GREEN', 'YELLOW', 'ORANGE', 'RED'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export interface UserIdentity {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface Loan {
  id: string;
  externalId: string;
  borrowerName: string;
  address: string | null;
  status: string;
  createdAt: string;
}

export interface OwnerVote {
  id: string;
  requestId: string;
  ownerUserId: string;
  vote: VoteKind;
  reason: string | null;
  votedAt: string;
  supersededAt: string | null;
}

export interface Comment {
  id: string;
  requestId: string;
  loanId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

export interface Attachment {
  id: string;
  requestId: string | null;
  commentId: string | null;
  fileName: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedByUserId: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  requestId: string | null;
  loanId: string | null;
  actorUserId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  at: string;
}

export interface ApprovalRequest {
  id: string;
  loanId: string;
  requestType: RequestType;
  status: RequestStatus;
  title: string;
  summary: string;
  intakeSource: IntakeSource;
  submittedByUserId: string;
  submittedAt: string;
  dueAt: string | null;
  urgency: UrgencyLevel;
  requiredApprovals: number;
  closedAt: string | null;
  withdrawnAt: string | null;
  version: number;
}

export interface ApprovalRequestWithContext extends ApprovalRequest {
  loan: Loan;
  submittedBy: UserIdentity;
  votes: OwnerVote[];
  attachments: Attachment[];
}
