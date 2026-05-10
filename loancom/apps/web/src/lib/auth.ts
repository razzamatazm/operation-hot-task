import type { UserIdentity } from '@loancom/shared';

const STORAGE_KEY = 'loancom.mockUserId';

export function getMockUserId(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setMockUserId(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

export async function fetchMe(): Promise<UserIdentity | null> {
  const id = getMockUserId();
  if (!id) return null;
  const r = await fetch('/api/me', { headers: { 'x-user-id': id } });
  if (!r.ok) return null;
  const data = (await r.json()) as { user: UserIdentity };
  return data.user;
}

export async function fetchUsers(): Promise<UserIdentity[]> {
  const r = await fetch('/api/users');
  if (!r.ok) throw new Error('failed to fetch users');
  const data = (await r.json()) as { users: UserIdentity[] };
  return data.users;
}
