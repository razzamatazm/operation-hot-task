import { config as appConfig } from "./config.js";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { buildRouter } from "./routes.js";
import { SseHub } from "./sse.js";
import { TaskStore } from "./store.js";
import { TeamsNotificationProvider } from "./notifications.js";
import { TaskService } from "./task-service.js";
import { startScheduler } from "./scheduler.js";
import { AppConfig } from "@loan-tasks/shared";
import { TeamsBotClient } from "./bot.js";

const bootstrap = async (): Promise<void> => {
  const app = express();
  const store = new TaskStore(appConfig.dataFile);
  await store.init();

  const botClient = new TeamsBotClient(appConfig.botAppId, appConfig.botAppPassword, appConfig.botReferencesFile);
  await botClient.init();

  const sse = new SseHub();

  const rules: AppConfig = {
    businessTimezone: appConfig.businessTimezone,
    businessStartHour: appConfig.businessStartHour,
    businessStartMinute: appConfig.businessStartMinute,
    businessEndHour: appConfig.businessEndHour,
    businessEndMinute: appConfig.businessEndMinute,
    archiveRetentionDays: appConfig.archiveRetentionDays
  };

  const notifier = new TeamsNotificationProvider(botClient);
  const service = new TaskService(store, notifier, sse, rules);

  app.use(cors());
  app.use(express.json());

  app.use("/api", buildRouter(service, sse));
  botClient.register(app);

  const resolvedFrontendDist = path.resolve(process.cwd(), appConfig.frontendDist);
  const indexFile = path.join(resolvedFrontendDist, "index.html");
  if (fs.existsSync(indexFile)) {
    app.use(express.static(resolvedFrontendDist));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(indexFile);
    });
    console.log(`serving_frontend=true path=${resolvedFrontendDist}`);
  } else {
    console.log(`serving_frontend=false missing=${indexFile}`);
  }

  const scheduler = startScheduler(service);

  const server = app.listen(appConfig.port, appConfig.host, () => {
    console.log(`loan-tasks-server running at http://${appConfig.host}:${appConfig.port}`);
    console.log(`bot_enabled=${botClient.isEnabled()}`);
  });

  process.on("SIGTERM", () => {
    clearInterval(scheduler);
    server.close();
  });

  process.on("SIGINT", () => {
    clearInterval(scheduler);
    server.close();
  });
};

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
