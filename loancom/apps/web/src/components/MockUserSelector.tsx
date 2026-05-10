import { useEffect, useState } from 'react';
import type { UserIdentity } from '@loancom/shared';
import { fetchUsers, getMockUserId, setMockUserId } from '../lib/auth';

interface Props {
  onChange: (user: UserIdentity) => void;
}

export function MockUserSelector({ onChange }: Props) {
  const [users, setUsers] = useState<UserIdentity[]>([]);
  const [selected, setSelected] = useState<string>(getMockUserId() ?? '');

  useEffect(() => {
    fetchUsers().then((list) => {
      setUsers(list);
      if (!selected && list.length > 0) {
        const owner = list.find((u) => u.role === 'OWNER') ?? list[0];
        setMockUserId(owner.id);
        setSelected(owner.id);
        onChange(owner);
      } else if (selected) {
        const u = list.find((x) => x.id === selected);
        if (u) onChange(u);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="text-ink/70">acting as</span>
      <select
        value={selected}
        onChange={(e) => {
          const id = e.target.value;
          setSelected(id);
          setMockUserId(id);
          const u = users.find((x) => x.id === id);
          if (u) onChange(u);
        }}
        className="rounded border-2 border-ink/20 bg-white px-3 py-2 text-base font-medium"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName} — {u.role.toLowerCase()}
          </option>
        ))}
      </select>
    </label>
  );
}
