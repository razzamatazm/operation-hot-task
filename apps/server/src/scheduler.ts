import { TaskService } from "./task-service.js";

export const startScheduler = (service: TaskService): NodeJS.Timeout => {
  const interval = setInterval(async () => {
    try {
      const results = await service.runMaintenance();
      if (results.reminded > 0 || results.purged > 0 || results.autoArchived > 0) {
        console.log(`[scheduler] reminders=${results.reminded} autoArchived=${results.autoArchived} purged=${results.purged}`);
      }
    } catch (error) {
      console.error("[scheduler] failed", error);
    }
  }, 5 * 60 * 1000);

  return interval;
};
