import { Request, Response, Router } from "express";
import { UserIdentity, UserRole, nextFlowStatuses } from "@loan-tasks/shared";
import { AuthError, authenticate } from "./auth.js";
import { resolveUserByEmail } from "./graph-users.js";
import { config } from "./config.js";
import { SseHub } from "./sse.js";
import { TaskService } from "./task-service.js";
import { UserStore } from "./user-store.js";
import { TeamsBotClient } from "./bot.js";
import { ActivityFeedClient } from "./activity-feed.js";
import { createTaskSchema, reviewNoteSchema, transitionSchema, updatePointsSchema } from "./validation.js";

const ALLOWED_ROLES: UserRole[] = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"];

/* Map an error to a response. AuthError → 401, everything else → 400 (or a
   supplied fallback status). */
const sendError = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : fallback });
};

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

export const buildRouter = (service: TaskService, sse: SseHub, userStore: UserStore, botClient: TeamsBotClient, activityFeedClient: ActivityFeedClient): Router => {
  const router = Router();

  /* Resolve the caller: verify the SSO token (or accept dev headers), then
     upsert into the users table to attach DB-managed roles. Throws AuthError
     when SSO is required but the request can't be authenticated. */
  const getActor = async (req: Request): Promise<UserIdentity> => {
    const identity = await authenticate(req);
    const user = await userStore.upsertOnLogin(identity);
    const record = await userStore.get(user.id);
    if (record && record.active === false) {
      throw new AuthError("Your account has been deactivated. Contact an admin.", 403);
    }
    await service.registerUser(user);
    return user;
  };

  const requireAdmin = (user: UserIdentity): void => {
    if (!user.roles.includes("ADMIN")) {
      throw new AuthError("Admin role required", 403);
    }
  };

  /* Guard the last admin: block any change that would leave zero active
     admins. `willBeActiveAdmin` is the target's state AFTER the proposed op. */
  const ensureAdminRemains = async (targetId: string, willBeActiveAdmin: boolean): Promise<void> => {
    if (willBeActiveAdmin) {
      return;
    }
    const others = (await userStore.list()).filter(
      (u) => u.id !== targetId && u.active && u.roles.includes("ADMIN")
    );
    if (others.length === 0) {
      throw new AuthError("Can't remove the last active admin", 403);
    }
  };

  router.get("/health", (_req, res) => {
    res.json({ ok: true, clients: sse.count() });
  });

  /* Resolve the caller's identity from the SSO bearer token (or dev
     headers). The web app calls this on boot to populate the current user. */
  router.get("/me", async (req, res) => {
    try {
      const user = await getActor(req);
      res.json(user);
    } catch (error) {
      sendError(res, error, "Failed to resolve identity");
    }
  });

  /* Admin: system status for the admin panel (bot connectivity, etc.). */
  router.get("/status", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      res.json({
        bot: await botClient.status(),
        channelWebhook: Boolean(config.webhookUrl),
        /* Effective state, not the raw flag: ActivityFeedClient.isEnabled()
           is false when the flag is on but Graph/Teams creds are missing, so
           the admin panel won't show "On" when nothing can actually send. */
        activityFeed: activityFeedClient.isEnabled()
      });
    } catch (error) {
      sendError(res, error, "Failed to read status");
    }
  });

  /* Admin: list users + manage roles (onboarding + future admin UI). */
  router.get("/users", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      res.json({ users: await userStore.list() });
    } catch (error) {
      sendError(res, error, "Failed to list users");
    }
  });

  router.put("/users/:id/roles", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      const roles = Array.isArray((req.body as { roles?: unknown }).roles)
        ? ((req.body as { roles: unknown[] }).roles
            .map((role) => String(role).toUpperCase())
            .filter((role): role is UserRole => ALLOWED_ROLES.includes(role as UserRole)))
        : [];
      if (roles.length === 0) {
        res.status(400).json({ error: "At least one valid role is required" });
        return;
      }
      const target = await userStore.get(req.params.id);
      if (!target) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      await ensureAdminRemains(req.params.id, target.active && roles.includes("ADMIN"));
      const updated = await userStore.setRoles(req.params.id, roles);
      res.json({ user: updated });
    } catch (error) {
      sendError(res, error, "Failed to update roles");
    }
  });

  /* Admin: add a user by email (resolved via Entra/Graph). */
  router.post("/users", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      const body = req.body as { email?: unknown; roles?: unknown };
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const roles = Array.isArray(body.roles)
        ? body.roles
            .map((role) => String(role).toUpperCase())
            .filter((role): role is UserRole => ALLOWED_ROLES.includes(role as UserRole))
        : [];
      const resolved = await resolveUserByEmail(email);
      const user = await userStore.createByAdmin({
        id: resolved.id,
        displayName: resolved.displayName,
        roles,
        ...(resolved.email ? { email: resolved.email } : {})
      });
      res.status(201).json({ user });
    } catch (error) {
      sendError(res, error, "Failed to add user");
    }
  });

  /* Admin: activate / deactivate a user. */
  router.patch("/users/:id", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      const active = (req.body as { active?: unknown }).active;
      if (typeof active !== "boolean") {
        res.status(400).json({ error: "active (boolean) is required" });
        return;
      }
      if (!active && req.params.id === actor.id) {
        res.status(400).json({ error: "You can't deactivate yourself" });
        return;
      }
      const target = await userStore.get(req.params.id);
      if (!target) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      await ensureAdminRemains(req.params.id, active && target.roles.includes("ADMIN"));
      const updated = await userStore.setActive(req.params.id, active);
      res.json({ user: updated });
    } catch (error) {
      sendError(res, error, "Failed to update user");
    }
  });

  /* Admin: permanently remove a user. */
  router.delete("/users/:id", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      if (req.params.id === actor.id) {
        res.status(400).json({ error: "You can't remove yourself" });
        return;
      }
      await ensureAdminRemains(req.params.id, false);
      const removed = await userStore.remove(req.params.id);
      if (!removed) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error, "Failed to remove user");
    }
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
      sendError(res, error, "Invalid payload");
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
      sendError(res, error, "Failed to claim task");
    }
  });

  router.post("/tasks/:taskId/unclaim", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.unclaimTask(req.params.taskId, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to unclaim task");
    }
  });

  router.post("/tasks/:taskId/transition", async (req, res) => {
    try {
      const { status, reviewNotes } = transitionSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.transitionStatus(req.params.taskId, status, user, reviewNotes);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to transition task");
    }
  });

  router.post("/tasks/:taskId/points", async (req, res) => {
    try {
      const { points } = updatePointsSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskPoints(req.params.taskId, points, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update points");
    }
  });

  router.post("/tasks/:taskId/review-note", async (req, res) => {
    try {
      const { text } = reviewNoteSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.addReviewNote(req.params.taskId, text, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to add review note");
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
