import { getMockUserId } from './auth';

export interface FeedItem {
  id: string;
  title: string;
  requestType: string;
  intakeSource: string;
  urgency: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';
  submittedAt: string;
  dueAt: string | null;
  status:
    | 'IN_REVIEW'
    | 'PARTIALLY_APPROVED'
    | 'NEGOTIATING'
    | 'NEEDS_CLARIFICATION'
    | 'APPROVED'
    | 'WITHDRAWN'
    | 'CLOSED';
  loan: { id: string; externalId: string; borrowerName: string };
  submittedBy: { id: string; displayName: string };
  voteSummary: Array<{
    ownerUserId: string;
    ownerName: string;
    vote: 'APPROVE' | 'DENY' | 'NEEDS_CLARIFICATION' | null;
    votedAt: string | null;
  }>;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const userId = getMockUserId();
  if (!userId) throw new Error('no user selected');
  const headers = new Headers(init?.headers);
  headers.set('x-user-id', userId);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(path, { ...init, headers });
}

export async function getFeed(): Promise<FeedItem[]> {
  const r = await authedFetch('/api/feed');
  if (!r.ok) throw new Error(`feed: ${r.status}`);
  const data = (await r.json()) as { items: FeedItem[] };
  return data.items;
}
