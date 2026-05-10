import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve(repoRoot, '.env'));
loadEnvFile(resolve(repoRoot, '.env.local'));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: resolve(repoRoot, process.env.DATABASE_URL ?? 'apps/server/data/loancom.db'),
  attachmentDir: resolve(repoRoot, process.env.ATTACHMENT_DIR ?? 'apps/server/storage'),
  inboundApiKey: process.env.INBOUND_API_KEY ?? 'demo-inbound-key',
  repoRoot,
} as const;

export type Config = typeof config;
