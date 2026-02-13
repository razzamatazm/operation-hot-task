import { DEFAULT_CONFIG } from "@loan-tasks/shared";
import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parseNumber(process.env.PORT, 4100),
  host: process.env.HOST ?? "127.0.0.1",
  dataFile: process.env.DATA_FILE ?? "apps/server/data/tasks.json",
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
  botReferencesFile: process.env.BOT_REFERENCES_FILE ?? "apps/server/data/bot-references.json",
  inboundApiKey: process.env.INBOUND_API_KEY
};
