import { useState } from 'react';
import type { UserIdentity } from '@loancom/shared';
import { MockUserSelector } from './components/MockUserSelector';
import { Feed } from './routes/Feed';

export function App() {
  const [user, setUser] = useState<UserIdentity | null>(null);

  return (
    <div className="min-h-screen">
      <header className="border-b-2 border-ink/10 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold">Loancom</h1>
            <p className="text-sm text-ink/60">Loan committee approvals</p>
          </div>
          <MockUserSelector onChange={setUser} />
        </div>
      </header>
      <main>
        {user ? (
          <Feed user={user} />
        ) : (
          <div className="p-8 text-ink/60">Pick a user to begin…</div>
        )}
      </main>
    </div>
  );
}
