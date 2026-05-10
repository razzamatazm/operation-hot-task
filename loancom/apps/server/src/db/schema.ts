import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['OWNER', 'OFFICER', 'SERVICING', 'ADMIN'] }).notNull(),
  entraOid: text('entra_oid').unique(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  lastLoginAt: text('last_login_at'),
});

export const loans = sqliteTable('loans', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  borrowerName: text('borrower_name').notNull(),
  address: text('address'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  loanId: text('loan_id')
    .notNull()
    .references(() => loans.id),
  requestType: text('request_type', {
    enum: ['LOI', 'TERMS', 'VALUE', 'FUNDING', 'DOC_REDLINE', 'GENERIC_QUESTION'],
  }).notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  intakeSource: text('intake_source', { enum: ['WEB', 'EMAIL', 'INTEGRATION_API'] }).notNull(),
  submittedByUserId: text('submitted_by_user_id')
    .notNull()
    .references(() => users.id),
  submittedAt: text('submitted_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  dueAt: text('due_at'),
  urgency: text('urgency', { enum: ['GREEN', 'YELLOW', 'ORANGE', 'RED'] })
    .notNull()
    .default('YELLOW'),
  requiredApprovals: integer('required_approvals').notNull().default(2),
  closedAt: text('closed_at'),
  withdrawnAt: text('withdrawn_at'),
  version: integer('version').notNull().default(1),
});

export const ownerVotes = sqliteTable('owner_votes', {
  id: text('id').primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => approvalRequests.id),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id),
  vote: text('vote', { enum: ['APPROVE', 'DENY', 'NEEDS_CLARIFICATION'] }).notNull(),
  reason: text('reason'),
  votedAt: text('voted_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  supersededAt: text('superseded_at'),
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => approvalRequests.id),
  loanId: text('loan_id')
    .notNull()
    .references(() => loans.id),
  authorUserId: text('author_user_id')
    .notNull()
    .references(() => users.id),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  requestId: text('request_id').references(() => approvalRequests.id),
  commentId: text('comment_id').references(() => comments.id),
  fileName: text('file_name').notNull(),
  kind: text('kind', { enum: ['PDF', 'IMAGE', 'DOCX', 'EMAIL_BODY', 'OTHER'] }).notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  uploadedByUserId: text('uploaded_by_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  requestId: text('request_id').references(() => approvalRequests.id),
  loanId: text('loan_id').references(() => loans.id),
  actorUserId: text('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  detail: text('detail'),
  at: text('at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const integrationApiKeys = sqliteTable('integration_api_keys', {
  id: text('id').primaryKey(),
  keyHash: text('key_hash').notNull().unique(),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text('revoked_at'),
});

export const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OWNER','OFFICER','SERVICING','ADMIN')),
    entra_oid TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    borrower_name TEXT NOT NULL,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    request_type TEXT NOT NULL CHECK (request_type IN ('LOI','TERMS','VALUE','FUNDING','DOC_REDLINE','GENERIC_QUESTION')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    intake_source TEXT NOT NULL CHECK (intake_source IN ('WEB','EMAIL','INTEGRATION_API')),
    submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    due_at TEXT,
    urgency TEXT NOT NULL DEFAULT 'YELLOW' CHECK (urgency IN ('GREEN','YELLOW','ORANGE','RED')),
    required_approvals INTEGER NOT NULL DEFAULT 2,
    closed_at TEXT,
    withdrawn_at TEXT,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_requests_submitted_at ON approval_requests(submitted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_loan ON approval_requests(loan_id)`,
  `CREATE TABLE IF NOT EXISTS owner_votes (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES approval_requests(id),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    vote TEXT NOT NULL CHECK (vote IN ('APPROVE','DENY','NEEDS_CLARIFICATION')),
    reason TEXT,
    voted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_votes_current ON owner_votes(request_id, owner_user_id) WHERE superseded_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES approval_requests(id),
    loan_id TEXT NOT NULL REFERENCES loans(id),
    author_user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_request ON comments(request_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_loan ON comments(loan_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    request_id TEXT REFERENCES approval_requests(id),
    comment_id TEXT REFERENCES comments(id),
    file_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('PDF','IMAGE','DOCX','EMAIL_BODY','OTHER')),
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    request_id TEXT REFERENCES approval_requests(id),
    loan_id TEXT REFERENCES loans(id),
    actor_user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS integration_api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT
  )`,
];
