import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import { SCHEMA_DDL } from './schema.js';

mkdirSync(dirname(config.databaseUrl), { recursive: true });

const sqlite = new Database(config.databaseUrl);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

for (const stmt of SCHEMA_DDL) {
  sqlite.exec(stmt);
}

export const db = drizzle(sqlite);
