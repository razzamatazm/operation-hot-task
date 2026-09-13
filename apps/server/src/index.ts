import { config as appConfig } from "./config.js";
import { ActivityFeedClient } from "./activity-feed.js";
import { ActivityFeedStateStore } from "./activity-feed-state.js";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { buildRouter } from "./routes.js";
import { SseHub } from "./sse.js";
import { LoanStore, TaskStore } from "./store.js";
import { LoanService } from "./loan-service.js";
import { backupStores } from "./data-backup.js";
import { UserStore } from "./user-store.js";
import { TeamsNotificationProvider } from "./notifications.js";
import { SettingsStore } from "./settings-store.js";
import { SavedForLaterStore } from "./saved-for-later-store.js";
import { TaskService } from "./task-service.js";
import { startScheduler } from "./scheduler.js";
import { AppConfig, currentAssigneeWasHanded } from "@loan-tasks/shared";
import { TeamsBotClient } from "./bot.js";

process.on("unhandledRejection", (reason) => {
  console.error("unhandled_rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("uncaught_exception", error);
});

const bootstrap = async (): Promise<void> => {
  const app = express();
  const store = new TaskStore(appConfig.dataFile);
  await store.init();
  const loanStore = new LoanStore(appConfig.loansFile);
  await loanStore.init();
  const userStore = new UserStore(appConfig.usersFile);
  await userStore.init();
  /* Handed to the router and to nothing else (ADR-0011 rule 3): no service,
     scheduler or bot handler below can reach a Saved for Later task. */
  const savedForLater = new SavedForLaterStore(appConfig.savedForLaterFile);
  await savedForLater.init();

  const botClient = new TeamsBotClient(
    appConfig.botAppId,
    appConfig.botAppPassword,
    appConfig.botTenantId,
    appConfig.botReferencesFile,
    async (aadObjectId, teamsUserId) => {
      await userStore.setTeamsUserId(aadObjectId, teamsUserId);
    }
  );
  await botClient.init();
  const activityFeedClient = new ActivityFeedClient();
  const activityFeedState = new ActivityFeedStateStore(appConfig.activityFeedStateFile);
  await activityFeedState.init();
  const settingsStore = new SettingsStore(appConfig.adminSettingsFile);
  await settingsStore.init();
  botClient.setNotificationChannelResolver(async () => settingsStore.getNotificationChannelId());

  const sse = new SseHub();

  const rules: AppConfig = {
    businessTimezone: appConfig.businessTimezone,
    businessStartHour: appConfig.businessStartHour,
    businessStartMinute: appConfig.businessStartMinute,
    businessEndHour: appConfig.businessEndHour,
    businessEndMinute: appConfig.businessEndMinute,
    archiveRetentionDays: appConfig.archiveRetentionDays
  };

  const notifier = new TeamsNotificationProvider(botClient, activityFeedClient, settingsStore, async (userId) =>
    userStore.getIdentity(userId)
  );
  const loanService = new LoanService(loanStore, store, sse);
  /* Idempotent (#370): every stored Humperdink link becomes its loan's Details
     page, after copying tasks.json and loans.json into data/backups/. Runs
     before the backfill below, which clusters on links. Records left sharing a
     link are logged one by one and never merged here. */
  const relinked = await loanService.canonicalizeStoredLinks({
    backup: () => backupStores([store, loanStore], path.join(path.dirname(appConfig.dataFile), "backups"))
  });
  if (relinked.backupDir) {
    console.log(
      `loan_link_rewrite loans=${relinked.loansRewritten} tasks=${relinked.tasksRewritten} ` +
        `collisions=${relinked.collisions.length} backup=${relinked.backupDir}`
    );
  }
  // One-time, idempotent migration (ADR-0001): back existing non-OOO tasks
  // with Loan records + loanId. Safe to run every boot — only touches tasks
  // that still lack a loanId.
  const migrated = await loanService.migrateExistingTasks();
  if (migrated.loansCreated > 0 || migrated.tasksLinked > 0) {
    console.log(`loan_migration loans_created=${migrated.loansCreated} tasks_linked=${migrated.tasksLinked}`);
  }
  const service = new TaskService(store, notifier, sse, rules, activityFeedState, loanService);
  /* A loan edit changes what every task on that loan displays, including on the
     cards already posted to Teams (#280). The loan service asks for those to be
     corrected without knowing the notification layer exists; the work runs in
     the background, off the request the person renaming is waiting on. */
  loanService.setCardCorrector((taskId, previousLoan) => service.correctTaskCards(taskId, previousLoan));
  /* Idempotent (#207): start the pool-nag clock on unclaimed tasks that are
     already past the nag threshold with no stamp — the shape a task written
     before the nag existed has — so the first maintenance pass does not read the
     whole backlog as never-nagged and post one card per task at once. Runs every
     boot; a task too young to have earned a nag is deliberately left alone, so a
     restart never delays one. */
  const nagBackfill = await service.backfillPoolNagClock();
  if (nagBackfill.stamped > 0) {
    console.log(`pool_nag_backfill stamped=${nagBackfill.stamped}`);
  }
  botClient.setClaimHandler(
    async (aadObjectId) => userStore.getIdentity(aadObjectId),
    async (taskId, user) => service.claimTask(taskId, user)
  );
  botClient.setNoteReplyHandler(
    async (aadObjectId) => userStore.getIdentity(aadObjectId),
    // Not addReviewNote directly: a COMPLETED task's card keeps its reply box.
    async (taskId, text, user) => service.addNoteFromCard(taskId, text, user)
  );
  botClient.setTransitionHandler(
    async (aadObjectId) => userStore.getIdentity(aadObjectId),
    async (taskId, status, user, reviewNotes) => service.transitionStatus(taskId, status, user, reviewNotes)
  );
  botClient.setReleaseHandler(
    async (aadObjectId) => userStore.getIdentity(aadObjectId),
    async (taskId, user) => service.releaseForAnyChecker(taskId, user)
  );
  // Lets the user-specific card refresh read live task state (creator → Cancel).
  botClient.setTaskLookup(async (taskId) => service.getTask(taskId));
  // Lets a rejected card tap repair the stale card that offered the button.
  botClient.setCardResync(async (taskId) => service.resyncTaskCards(taskId));
  /* Idempotent (ADR-0002): channel cards posted before a handoff edited them
     still offer Claim on a task somebody was handed. A repaired card records
     its holder and is skipped on every later boot. In the background, so a slow
     Teams call never holds up start-up. */
  botClient
    .repairHandedOffCards(async (task) => currentAssigneeWasHanded(await service.getHistory(task.id)))
    .then(({ repaired }) => {
      if (repaired > 0) {
        console.log(`handoff_card_repair repaired=${repaired}`);
      }
    })
    .catch((error) => console.error("handoff_card_repair_failed", error));

  app.use(cors());
  app.use(express.json());

  app.use("/api", buildRouter(service, sse, userStore, botClient, activityFeedClient, settingsStore, loanService, savedForLater));
  botClient.register(app);

  const resolvedFrontendDist = path.resolve(process.cwd(), appConfig.frontendDist);
  const indexFile = path.join(resolvedFrontendDist, "index.html");
  if (appConfig.devMode) {
    /* #368: under `npm run dev` the build is whatever was last made and nothing
       rebuilds it, so serving it shows a stale board. Send page requests to the
       live Vite page instead, keeping the hostname the browser used. */
    // Same path match as the production catch-all below, so /api is untouched in both.
    app.get(/^\/(?!api).*/, (req, res) => {
      res.redirect(302, `${req.protocol}://${req.hostname}:${appConfig.webPort}${req.originalUrl}`);
    });
    console.log(`serving_frontend=false dev_mode=true redirect_web_port=${appConfig.webPort}`);
  } else if (fs.existsSync(indexFile)) {
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
