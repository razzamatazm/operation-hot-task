import { useEffect, useState } from 'react';
import type { UserIdentity } from '@loancom/shared';
import { getFeed, type FeedItem } from '../lib/api';

interface Props {
  user: UserIdentity;
}

const URGENCY_STYLE: Record<FeedItem['urgency'], string> = {
  RED: 'bg-urgencyRed text-white',
  ORANGE: 'bg-urgencyOrange text-white',
  YELLOW: 'bg-urgencyYellow text-white',
  GREEN: 'bg-urgencyGreen text-white',
};

const STATUS_STYLE: Record<FeedItem['status'], string> = {
  IN_REVIEW: 'bg-blue-100 text-blue-900',
  PARTIALLY_APPROVED: 'bg-amber-100 text-amber-900',
  NEGOTIATING: 'bg-orange-100 text-orange-900',
  NEEDS_CLARIFICATION: 'bg-purple-100 text-purple-900',
  APPROVED: 'bg-green-100 text-green-900',
  WITHDRAWN: 'bg-gray-200 text-gray-700',
  CLOSED: 'bg-gray-200 text-gray-700',
};

const STATUS_LABEL: Record<FeedItem['status'], string> = {
  IN_REVIEW: 'In review',
  PARTIALLY_APPROVED: 'One approval, one pending',
  NEGOTIATING: 'Negotiating',
  NEEDS_CLARIFICATION: 'Needs clarification',
  APPROVED: 'Approved',
  WITHDRAWN: 'Withdrawn',
  CLOSED: 'Closed',
};

const TYPE_LABEL: Record<string, string> = {
  LOI: 'LOI',
  TERMS: 'Terms',
  VALUE: 'Valuation',
  FUNDING: 'Funding',
  DOC_REDLINE: 'Redlines',
  GENERIC_QUESTION: 'Question',
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function Feed({ user }: Props) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    getFeed()
      .then(setItems)
      .catch((e) => setError(String(e)));
  }, [user.id]);

  if (error) return <div className="p-8 text-urgencyRed">{error}</div>;
  if (items === null) return <div className="p-8 text-ink/60">Loading…</div>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold">Pending requests</h1>
      <p className="mb-6 text-ink/70">
        {items.length === 0
          ? "Nothing here. You're caught up."
          : `${items.length} item${items.length === 1 ? '' : 's'} need attention.`}
      </p>
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            className="group rounded-lg border-2 border-ink/10 bg-white p-5 hover:border-accent focus-within:border-accent"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className={`badge ${URGENCY_STYLE[item.urgency]}`}>{item.urgency}</span>
                  <span className="badge bg-ink/10 text-ink">{TYPE_LABEL[item.requestType] ?? item.requestType}</span>
                  <span className={`badge ${STATUS_STYLE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                  <span className="text-sm text-ink/60">via {item.intakeSource.toLowerCase()}</span>
                </div>
                <h2 className="text-xl font-semibold">{item.title}</h2>
                <p className="mt-1 text-base text-ink/70">
                  {item.loan.borrowerName} · {item.loan.externalId} · submitted by {item.submittedBy.displayName}{' '}
                  {relativeTime(item.submittedAt)}
                </p>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  {item.voteSummary.map((v) => (
                    <span
                      key={v.ownerUserId}
                      className={
                        v.vote === 'APPROVE'
                          ? 'text-urgencyGreen font-semibold'
                          : v.vote === 'DENY'
                            ? 'text-urgencyRed font-semibold'
                            : v.vote === 'NEEDS_CLARIFICATION'
                              ? 'text-purple-800 font-semibold'
                              : 'text-ink/50'
                      }
                    >
                      {v.ownerName}: {v.vote ?? 'pending'}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
