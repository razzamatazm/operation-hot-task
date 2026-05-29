import { Router } from "express";
import { UserIdentity, nextFlowStatuses } from "@loan-tasks/shared";
import { getUserFromRequest } from "./auth.js";
import { config } from "./config.js";
import { SseHub } from "./sse.js";
import { TaskService } from "./task-service.js";
import { createTaskSchema, reviewNoteSchema, transitionSchema, updatePointsSchema } from "./validation.js";

const toCreateInput = (body: unknown) => {
  const parsed = createTaskSchema.parse(body);
  const folderName = parsed.folderName?.trim() || parsed.loanName?.trim() || parsed.serverLocation?.trim();
  if (!folderName) {
    throw new Error("folderName is required");
  }
  return {
    folderName,
    taskType: parsed.taskType,
    notes: parsed.notes,
    ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
    ...(parsed.returnDate ? { returnDate: parsed.returnDate } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...(parsed.points ? { points: parsed.points } : {}),
    ...(parsed.humperdinkLink ? { humperdinkLink: parsed.humperdinkLink } : {})
  };
};

export const buildRouter = (service: TaskService, sse: SseHub): Router => {
  const router = Router();
  const getActor = async (req: Parameters<typeof getUserFromRequest>[0]) => {
    const user = getUserFromRequest(req);
    await service.registerUser(user);
    return user;
  };

  router.get("/health", (_req, res) => {
    res.json({ ok: true, clients: sse.count() });
  });

  router.get("/tasks", async (_req, res) => {
    const tasks = await service.listTasks();
    res.json({ tasks });
  });

  router.post("/tasks", async (req, res) => {
    try {
      const input = toCreateInput(req.body);
      const user = await getActor(req);
      const task = await service.createTask(input, user);
      res.status(201).json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payload" });
    }
  });

  router.post("/integrations/tasks", async (req, res) => {
    if (!config.inboundApiKey) {
      res.status(503).json({ error: "Inbound integration endpoint is disabled" });
      return;
    }

    const providedKey = String(req.header("x-api-key") ?? "");
    if (providedKey !== config.inboundApiKey) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    try {
      const input = toCreateInput(req.body);
      const integrationUser: UserIdentity = {
        id: "integration",
        displayName: "In-house Integration",
        roles: ["LOAN_OFFICER"]
      };
      await service.registerUser(integrationUser);
      const task = await service.createTask(input, integrationUser);
      res.status(201).json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payload" });
    }
  });

  router.get("/tasks/:taskId", async (req, res) => {
    const task = await service.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    res.json({ task, allowedTransitions: nextFlowStatuses(task) });
  });

  router.get("/tasks/:taskId/history", async (req, res) => {
    const task = await service.getTask(req.params.taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const history = await service.getHistory(req.params.taskId);
    res.json({ history });
  });

  router.post("/tasks/:taskId/claim", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.claimTask(req.params.taskId, user);
      res.json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to claim task" });
    }
  });

  router.post("/tasks/:taskId/unclaim", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.unclaimTask(req.params.taskId, user);
      res.json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to unclaim task" });
    }
  });

  router.post("/tasks/:taskId/transition", async (req, res) => {
    try {
      const { status, reviewNotes } = transitionSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.transitionStatus(req.params.taskId, status, user, reviewNotes);
      res.json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to transition task" });
    }
  });

  router.post("/tasks/:taskId/points", async (req, res) => {
    try {
      const { points } = updatePointsSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskPoints(req.params.taskId, points, user);
      res.json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to update points" });
    }
  });

  router.post("/tasks/:taskId/review-note", async (req, res) => {
    try {
      const { text } = reviewNoteSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.addReviewNote(req.params.taskId, text, user);
      res.json({ task });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to add review note" });
    }
  });

  router.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    /* Disable proxy buffering (nginx, vite dev proxy) so chunks flush live. */
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    sse.addClient(res);
    res.write("event: connected\ndata: {}\n\n");

    /* Heartbeat keeps intermediate proxies from coalescing the stream. */
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sse.removeClient(res);
    });
  });

  return router;
};
