#!/usr/bin/env node
/*
 * Onboarding seed for the users table (Phase 2 team rollout).
 *
 * Usage:
 *   node scripts/seed-users.mjs <roster.json> [data/users.json]
 *
 * <roster.json> is an array of:
 *   [
 *     { "id": "<AAD oid>", "displayName": "Suzie", "email": "suzie@co.com",
 *       "roles": ["LOAN_OFFICER"] },
 *     ...
 *   ]
 *
 * Produce the roster from Microsoft Graph (needs TeamMember.Read.All or
 * GroupMember.Read.All admin consent on the server's app registration):
 *   GET https://graph.microsoft.com/v1.0/teams/{teamId}/members
 * Map each member's `id` (the AAD oid) + displayName + email, then assign
 * roles with Tyler. New members who join later auto-create on first login
 * with the default LOAN_OFFICER role; promote them via PUT /api/users/:id/roles.
 *
 * Merge semantics: upsert by id. Preserves existing createdAt / teamsUserId.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ALLOWED_ROLES = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"];

const [, , rosterArg, usersArg] = process.argv;
if (!rosterArg) {
  console.error("Usage: node scripts/seed-users.mjs <roster.json> [data/users.json]");
  process.exit(1);
}

const usersFile = usersArg
  ? path.resolve(process.cwd(), usersArg)
  : path.resolve(process.cwd(), "apps/server/data/users.json");

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

const roster = await readJson(path.resolve(process.cwd(), rosterArg), null);
if (!Array.isArray(roster)) {
  console.error(`Roster ${rosterArg} is not a JSON array.`);
  process.exit(1);
}

const data = await readJson(usersFile, { users: [] });
if (!Array.isArray(data.users)) {
  data.users = [];
}

const now = new Date().toISOString();
let created = 0;
let updated = 0;

for (const entry of roster) {
  if (!entry?.id || !entry?.displayName) {
    console.warn("Skipping entry without id/displayName:", JSON.stringify(entry));
    continue;
  }
  const roles = Array.isArray(entry.roles)
    ? entry.roles.map((r) => String(r).toUpperCase()).filter((r) => ALLOWED_ROLES.includes(r))
    : [];
  if (roles.length === 0) {
    console.warn(`Skipping ${entry.displayName}: no valid roles (got ${JSON.stringify(entry.roles)})`);
    continue;
  }

  const index = data.users.findIndex((u) => u.id === entry.id);
  const existing = index >= 0 ? data.users[index] : undefined;
  const record = {
    id: entry.id,
    displayName: entry.displayName,
    roles,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: existing?.lastSeenAt ?? now
  };
  const email = entry.email ?? existing?.email;
  if (email) record.email = email;
  if (existing?.teamsUserId) record.teamsUserId = existing.teamsUserId;

  if (index >= 0) {
    data.users[index] = record;
    updated += 1;
  } else {
    data.users.push(record);
    created += 1;
  }
}

await fs.mkdir(path.dirname(usersFile), { recursive: true });
await fs.writeFile(usersFile, JSON.stringify(data, null, 2), "utf8");

console.log(`Seeded ${usersFile}: ${created} created, ${updated} updated, ${data.users.length} total.`);
