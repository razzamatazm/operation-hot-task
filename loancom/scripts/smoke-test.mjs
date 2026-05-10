#!/usr/bin/env node
// Demo smoke test: boots the server in-process, hits /health, /api/users, and
// /api/feed as a seeded owner, asserts shape. Exits non-zero on failure.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT ?? '4000';
const env = { ...process.env, PORT };

const server = spawn('npm', ['run', 'dev:server'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdoutBuf = '';
server.stdout.on('data', (b) => {
  const s = b.toString();
  stdoutBuf += s;
  process.stdout.write(`[server] ${s}`);
});
server.stderr.on('data', (b) => {
  process.stderr.write(`[server-err] ${b}`);
});

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  const ok = await waitFor(() => stdoutBuf.includes('listening on'), 30_000);
  if (!ok) throw new Error('server did not start');

  // /health
  const h = await fetch(`http://localhost:${PORT}/api/health`);
  if (!h.ok) throw new Error('/api/health failed');
  const hj = await h.json();
  if (!hj.ok) throw new Error('/api/health bad shape');
  console.log('[smoke] /api/health ok');

  // /users
  const u = await fetch(`http://localhost:${PORT}/api/users`);
  const uj = await u.json();
  if (!Array.isArray(uj.users) || uj.users.length === 0) throw new Error('/api/users empty');
  const owner = uj.users.find((x) => x.role === 'OWNER');
  if (!owner) throw new Error('no owner seeded');
  console.log(`[smoke] /api/users -> ${uj.users.length} users, owner = ${owner.displayName}`);

  // /feed as owner
  const f = await fetch(`http://localhost:${PORT}/api/feed`, {
    headers: { 'x-user-id': owner.id },
  });
  if (!f.ok) throw new Error(`/api/feed failed ${f.status}`);
  const fj = await f.json();
  if (!Array.isArray(fj.items)) throw new Error('/api/feed bad shape');
  console.log(`[smoke] /api/feed -> ${fj.items.length} items`);
  for (const item of fj.items) {
    console.log(`  - [${item.urgency}] ${item.title} (${item.status})`);
  }

  const negotiating = fj.items.find((i) => i.status === 'NEGOTIATING');
  if (!negotiating) throw new Error('expected at least one NEGOTIATING request in seed');
  const partial = fj.items.find((i) => i.status === 'PARTIALLY_APPROVED');
  if (!partial) throw new Error('expected at least one PARTIALLY_APPROVED request in seed');
  const approved = fj.items.find((i) => i.status === 'APPROVED');
  if (!approved) throw new Error('expected at least one APPROVED request in seed');
  console.log('[smoke] all expected statuses present');
}

main()
  .then(() => {
    server.kill('SIGTERM');
    process.exit(0);
  })
  .catch((e) => {
    console.error('[smoke] FAIL:', e);
    server.kill('SIGTERM');
    process.exit(1);
  });
