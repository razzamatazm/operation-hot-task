import { DEFAULT_CONFIG } from "@loan-tasks/shared";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Resolve relative data paths against the server package root, not the
// process cwd, so dev (cwd=apps/server) and prod (cwd=repo root) and
// smoke (cwd=repo root) all land on the same files. Absolute paths
// (smoke uses os.tmpdir()) pass through untouched.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolveServerPath = (value: string | undefined, fallback: string): string => {
  const raw = value ?? fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(SERVER_ROOT, raw);
};

export const config = {
  port: parseNumber(process.env.PORT, 4100),
  host: process.env.HOST ?? "127.0.0.1",
  dataFile: resolveServerPath(process.env.DATA_FILE, "data/tasks.json"),
  frontendDist: resolveServerPath(process.env.FRONTEND_DIST, "../web/dist"),
  businessTimezone: process.env.BUSINESS_TIMEZONE ?? DEFAULT_CONFIG.businessTimezone,
  businessStartHour: parseNumber(process.env.BUSINESS_START_HOUR, DEFAULT_CONFIG.businessStartHour),
  businessStartMinute: parseNumber(process.env.BUSINESS_START_MINUTE, DEFAULT_CONFIG.businessStartMinute),
  businessEndHour: parseNumber(process.env.BUSINESS_END_HOUR, DEFAULT_CONFIG.businessEndHour),
  businessEndMinute: parseNumber(process.env.BUSINESS_END_MINUTE, DEFAULT_CONFIG.businessEndMinute),
  archiveRetentionDays: parseNumber(process.env.ARCHIVE_RETENTION_DAYS, DEFAULT_CONFIG.archiveRetentionDays),
  tasksChannelName: process.env.TASKS_CHANNEL_NAME ?? "loan-tasks",
  webhookUrl: process.env.TEAMS_CHANNEL_WEBHOOK_URL,
  enableDmNotifications: (process.env.ENABLE_DM_NOTIFICATIONS ?? "true") === "true",
  botAppId: process.env.BOT_APP_ID,
  botAppPassword: process.env.BOT_APP_PASSWORD,
  botTenantId: process.env.BOT_TENANT_ID,
  botReferencesFile: resolveServerPath(process.env.BOT_REFERENCES_FILE, "data/bot-references.json"),
  inboundApiKey: process.env.INBOUND_API_KEY,
  enableActivityFeedNotifications: (process.env.ENABLE_ACTIVITY_FEED_NOTIFICATIONS ?? "false") === "true",
  activityFeedStateFile: resolveServerPath(process.env.ACTIVITY_FEED_STATE_FILE, "data/activity-feed-state.json"),
  graphTenantId: process.env.GRAPH_TENANT_ID,
  graphClientId: process.env.GRAPH_CLIENT_ID,
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET,
  graphBaseUrl: process.env.GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0",
  teamsAppId: process.env.TEAMS_APP_ID
};
