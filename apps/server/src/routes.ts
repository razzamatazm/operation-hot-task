import { Request, Response, Router } from "express";
import { LOAN_EDIT_NEEDS_TASK, LOAN_EDIT_WRONG_LOAN, UserIdentity, UserRole, loanEditRefusal, nextFlowStatuses } from "@loan-tasks/shared";
import { AuthError, authenticate } from "./auth.js";
import { resolveUserByEmail } from "./graph-users.js";
import { config } from "./config.js";
import { SseHub } from "./sse.js";
import { TaskService } from "./task-service.js";
import { UserStore } from "./user-store.js";
import { TeamsBotClient } from "./bot.js";
import { ActivityFeedClient } from "./activity-feed.js";
import { SettingsStore } from "./settings-store.js";
import { LoanLinkCollisionError, LoanService } from "./loan-service.js";
import {
  amendFolderNameSchema,
  amendNotesSchema,
  amendOooDatesSchema,
  amendUrgencySchema,
  assignSchema,
  checklistItemCheckedSchema,
  checklistItemNoteSchema,
  checklistItemTextSchema,
  createLoanSchema,
  createTaskSchema,
  messageEditSchema,
  reviewNoteSchema,
  transitionSchema,
  updateLoanSchema,
  updatePointsSchema
} from "./validation.js";

const ALLOWED_ROLES: UserRole[] = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"];

/* Map an error to a response. AuthError → 401, everything else → 400 (or a
   supplied fallback status). */
const sendError = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  /* A loan edit refused because the link belongs to another loan (#262). 409,
     not 400: the request is well-formed and the caller is not at fault — another
     record is in the way. The other loan rides along because the client turns
     this into the question "merge with that one?" and has to name it (#265),
     and nothing has been written either way. */
  if (error instanceof LoanLinkCollisionError) {
    res.status(409).json({ error: error.message, collision: error.collision });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : fallback });
};

const toCreateInput = (body: unknown) => {
  const parsed = createTaskSchema.parse(body);
  const folderName = parsed.folderName?.trim() || parsed.loanName?.trim() || parsed.serverLocation?.trim();
  if (!folderName && !parsed.loanId) {
    throw new Error("folderName or loanId is required");
  }
  return {
    ...(parsed.loanId ? { loanId: parsed.loanId } : {}),
    folderName: folderName ?? "",
    taskType: parsed.taskType,
    notes: parsed.notes,
    ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
    ...(parsed.startDate ? { startDate: parsed.startDate } : {}),
    ...(parsed.returnDate ? { returnDate: parsed.returnDate } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...(parsed.points ? { points: parsed.points } : {}),
    ...(parsed.humperdinkLink ? { humperdinkLink: parsed.humperdinkLink } : {}),
    ...(parsed.initialItems && parsed.initialItems.length > 0 ? { initialItems: parsed.initialItems } : {}),
    ...(parsed.assigneeUserId ? { assigneeUserId: parsed.assigneeUserId } : {}),
    ...(parsed.assigneeUserId && parsed.assigneeNote?.trim() ? { assigneeNote: parsed.assigneeNote.trim() } : {})
  };
};

export const buildRouter = (service: TaskService, sse: SseHub, userStore: UserStore, botClient: TeamsBotClient, activityFeedClient: ActivityFeedClient, settingsStore: SettingsStore, loanService: LoanService): Router => {
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

  /* Runtime client config. The web app calls this on boot (alongside /me) to
     learn the Teams app id so it can build the same deep link the bot does —
     it can't read TEAMS_APP_ID, which is server-only env. Deliberately not on
     /me (that stays about identity) and deliberately not a build-time VITE_
     var, so the server can change the app id without rebuilding the bundle.
     The app id isn't a secret — it's in the published Teams manifest — so this
     route is unauthenticated, like /health. */
  router.get("/config", (_req, res) => {
    res.json({ teamsAppId: config.teamsAppId?.trim() || null });
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

  /* Admin: list captured channels + the one group notifications target.
     `selected` is null when notifications broadcast to every channel. */
  router.get("/admin/channels", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      res.json({
        channels: await botClient.listChannels(),
        selected: (await settingsStore.getNotificationChannelId()) ?? null
      });
    } catch (error) {
      sendError(res, error, "Failed to list channels");
    }
  });

  /* Admin: set the channel group notifications go to. `channelId: null` clears
     the selection (revert to broadcasting to every channel). */
  router.put("/admin/channels", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      const channelId = (req.body as { channelId?: unknown }).channelId;
      if (channelId !== null && typeof channelId !== "string") {
        throw new Error("channelId must be a string or null");
      }
      await settingsStore.setNotificationChannelId(channelId);
      res.json({ selected: (await settingsStore.getNotificationChannelId()) ?? null });
    } catch (error) {
      sendError(res, error, "Failed to set channel");
    }
  });

  /* Any authenticated user: minimal read-only people directory for the share
     and handoff people-pickers (issue #41, ADR-0002). Returns id, displayName
     and roles for active users — no email or status. Roles are here so the
     handoff picker can filter to FILE_CHECKERs on a Fraud Check rather than
     offering people the server will reject; they're already visible in the
     admin panel, so this exposes nothing new. The full `/users` list below
     stays admin-only. */
  router.get("/users/directory", async (req, res) => {
    try {
      await getActor(req);
      const users = (await userStore.list())
        .filter((user) => user.active !== false)
        .map((user) => ({ id: user.id, displayName: user.displayName, roles: user.roles }));
      res.json({ users });
    } catch (error) {
      sendError(res, error, "Failed to list users");
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

  /* Admin: what a demotion or deactivation is about to release. The panel asks
     BEFORE it applies the change, so an admin sees which live Fraud Checks
     their edit will hand back to the pool rather than finding out afterwards.
     Read-only; the release itself happens on the write below. */
  router.get("/users/:id/fraud-checks", async (req, res) => {
    try {
      const actor = await getActor(req);
      requireAdmin(actor);
      const tasks = await service.liveFraudChecksForChecker(req.params.id);
      res.json({ tasks: tasks.map((task) => ({ id: task.id, folderName: task.folderName, status: task.status })) });
    } catch (error) {
      sendError(res, error, "Failed to list the user's fraud checks");
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
      /* The checker seat needs a LIVE FILE_CHECKER role (ADR-0003), so losing
         it vacates every seat it was holding. Release those checks back to the
         pool rather than leaving them stranded with a checker who can't check.
         After the role write, so a failed write releases nothing. */
      const releasedChecks = target.roles.includes("FILE_CHECKER") && !roles.includes("FILE_CHECKER")
        ? await service.releaseFraudChecksForChecker(req.params.id, actor)
        : [];
      res.json({ user: updated, releasedFraudChecks: releasedChecks.length });
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
      // Deactivation blocks them at auth, so their seats have to go the same
      // way a demotion's do — same method, same in-place release.
      const releasedChecks = !active ? await service.releaseFraudChecksForChecker(req.params.id, actor) : [];
      res.json({ user: updated, releasedFraudChecks: releasedChecks.length });
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
      /* Deleting a checker strands their live checks harder than demoting one
         does — there is no user record left to release them from later — so it
         takes the same release, after the record is gone. */
      const releasedChecks = await service.releaseFraudChecksForChecker(req.params.id, actor);
      res.json({ ok: true, releasedFraudChecks: releasedChecks.length });
    } catch (error) {
      sendError(res, error, "Failed to remove user");
    }
  });

  /* Loans (ADR-0001). Search powers the create-form typeahead; create/get
     back it; PATCH is the Loan-scoped edit surface (name + link).

     Creating is still open to any authenticated user — filing a task mints or
     joins a loan, and that is the same trust as filing the task. *Changing* one
     is not: since #266 a PATCH has to name a task on the loan and the caller has
     to be a party to it (ADR-0008 rule 5). */
  router.get("/loans", async (req, res) => {
    try {
      if (req.query.q !== undefined) {
        const query = typeof req.query.q === "string" ? req.query.q : "";
        const matches = await loanService.search(query);
        res.json({ loans: matches.map((m) => m.loan) });
        return;
      }
      res.json({ loans: await loanService.list() });
    } catch (error) {
      sendError(res, error, "Failed to list loans");
    }
  });

  router.post("/loans", async (req, res) => {
    try {
      await getActor(req);
      const input = createLoanSchema.parse(req.body);
      const loan = await loanService.create({
        name: input.name,
        ...(input.humperdinkLink ? { humperdinkLink: input.humperdinkLink } : {})
      });
      res.status(201).json({ loan });
    } catch (error) {
      sendError(res, error, "Failed to create loan");
    }
  });

  router.get("/loans/:loanId", async (req, res) => {
    const loan = await loanService.get(req.params.loanId);
    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }
    res.json({ loan });
  });

  router.patch("/loans/:loanId", async (req, res) => {
    try {
      /* Who is editing, threaded through: a loan edit rewrites what every task
         on that loan displays, so each of them earns a history row naming the
         person and both values (ADR-0008 rule 9, #262) — and, since #266,
         decides whether the edit happens at all. */
      const actor = await getActor(req);
      const input = updateLoanSchema.parse(req.body);

      /* The permission gate, and the whole of #266 on the server side.

         It runs on EVERY patch, including the one a confirmed merge re-sends
         (#265): the confirm posts the identical body a second time, so a check
         that only guarded the first would let a refusal be dodged by answering
         a dialog. The rule is asked once, here, before anything is written.

         `isTaskParty` and the sentences both come from `@loan-tasks/shared`, so
         the box the web greys out and the request the server refuses are the
         same rule rather than two that agree today. Nothing below consults
         roles: an admin is not a party, and ADR-0003 is explicit that back-end
         access confers nothing over other people's work. */
      if (!input.taskId) {
        throw new Error(LOAN_EDIT_NEEDS_TASK);
      }
      const editedFrom = await service.getTask(input.taskId);
      if (!editedFrom) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      /* 403, not 400. A well-formed request naming a task on somebody else's
         loan is not a malformed body — it is the party refusal wearing a
         disguise, and answering it as a bad request would let a caller tell
         "I typed this wrong" apart from "I have no standing here" by reading
         the status. Being a party to task A confers nothing over loan B. */
      if (editedFrom.loanId !== req.params.loanId) {
        res.status(403).json({ error: LOAN_EDIT_WRONG_LOAN });
        return;
      }
      const refusal = loanEditRefusal(editedFrom, actor);
      if (refusal) {
        res.status(403).json({ error: refusal });
        return;
      }

      const result = await loanService.update(
        req.params.loanId,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.humperdinkLink !== undefined ? { humperdinkLink: input.humperdinkLink } : {})
        },
        /* A merge only happens when the caller says it may (#265). The first
           save never carries the flag, so a colliding link comes back as the
           409 below with the other loan named; the client asks, and only a
           confirmed re-send gets here with `confirmMerge` set. */
        { actor, ...(input.confirmMerge ? { confirmMerge: true } : {}) }
      );
      res.json({ loan: result.loan, ...(result.merged ? { merged: result.merged } : {}) });
    } catch (error) {
      sendError(res, error, "Failed to update loan");
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
      // Handoff at creation (ADR-0002): resolve the recipient so the task is
      // born assigned in one operation rather than created-then-assigned.
      // Eligibility is NOT checked here — ADR-0003 moved it into
      // `createTask` so one seam covers all four doors an assignee comes
      // through. The route only turns an id into an identity.
      if (input.assigneeUserId) {
        const target = await userStore.get(input.assigneeUserId);
        if (!target || target.active === false) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        const task = await service.createTask(input, user, target);
        res.status(201).json({ task });
        return;
      }
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

  /* FRAUD "Release for any fraud checker": the creator hands a
     PENDING_APPROVAL task back to the pool (unassign in place). */
  router.post("/tasks/:taskId/release", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.releaseForAnyChecker(req.params.taskId, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to release task");
    }
  });

  /* Put a claimed task back in the pool (#208) — the creator's counterpart to
     the handoff, and the only way a task moves off a stalled holder now that
     nobody may hand one to themselves. Policy lives in the service. */
  router.post("/tasks/:taskId/return-to-pool", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.returnToPool(req.params.taskId, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to return task to the pool");
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

  /* Amend the ask (ADR-0006, #160, extended by ADR-0008 rule 8). Three routes,
     not one patch — the URL names the field, so the rule that refuses is the
     rule the route is about. */
  router.post("/tasks/:taskId/notes", async (req, res) => {
    try {
      const { notes } = amendNotesSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskNotes(req.params.taskId, notes, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update notes");
    }
  });

  router.post("/tasks/:taskId/urgency", async (req, res) => {
    try {
      const { urgency } = amendUrgencySchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskUrgency(req.params.taskId, urgency, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update urgency");
    }
  });

  /* An OOO task's vacation description (#262, ADR-0008 rule 7). Third focused
     route, same shape as the two above. Every other type's folder name is the
     shared Loan record's name and is edited through `PATCH /loans/:loanId`; the
     service refuses this route for them rather than quietly writing one task's
     copy out of step with its loan. */
  router.post("/tasks/:taskId/folder-name", async (req, res) => {
    try {
      const { folderName } = amendFolderNameSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskFolderName(req.params.taskId, folderName, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update description");
    }
  });

  /* An OOO task's start and return dates (#264). One route taking both,
     because they are one range: the rule is that the start is on or before the
     return, which cannot be asked of half of it. */
  router.post("/tasks/:taskId/dates", async (req, res) => {
    try {
      const { startDate, returnDate } = amendOooDatesSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.updateTaskOooDates(req.params.taskId, startDate, returnDate, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update dates");
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

  /* Add a note to a COMPLETED task (issue #45). Server-atomic append that keeps
     the task COMPLETED — the card's "Add a note" affordance posts here instead
     of round-tripping the task through OPEN. */
  router.post("/tasks/:taskId/completed-note", async (req, res) => {
    try {
      const { text } = reviewNoteSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.addCompletedNote(req.params.taskId, text, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to add note");
    }
  });

  /* Correct a message you posted (#287, ADR-0009). Addressed by the message's
     own identifier, which is what #286 gave it — its timestamp could not do the
     job, because rule 6 freezes that across an edit.

     Shaped after the checklist item's text endpoint rather than as a PATCH on
     the message, so that #288's `DELETE /tasks/:taskId/messages/:messageId` can
     sit beside it on the same noun without either reshaping the other. The
     author-only rule and the archived gate are enforced in the service off the
     shared `messageEditRefusal`; hiding the menu in the web app is a courtesy,
     not the enforcement. */
  router.post("/tasks/:taskId/messages/:messageId/text", async (req, res) => {
    try {
      const { text } = messageEditSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.editReviewNote(req.params.taskId, req.params.messageId, text, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to edit the message");
    }
  });

  /* FRAUD structured outstanding-items checklist (#44, gated deletion #66).
     Focused, atomic endpoints mirroring the completed-note pattern — each
     enforces its permission rule and the gated-deletion / checked-stale
     invariants server-side. DELETE is gated (adder-only, still a fresh draft —
     see canDeleteChecklistItem; no turn clause). submit / approve /
     bounce-back ride the existing /transition endpoint (the pass counter bumps
     there, and each hand-off commits existing items against further
     deletion). */
  router.post("/tasks/:taskId/checklist/items", async (req, res) => {
    try {
      const { text } = checklistItemTextSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.addChecklistItem(req.params.taskId, text, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to add checklist item");
    }
  });

  router.post("/tasks/:taskId/checklist/items/:itemId/text", async (req, res) => {
    try {
      const { text } = checklistItemTextSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.editChecklistItemText(req.params.taskId, req.params.itemId, text, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to edit checklist item");
    }
  });

  router.delete("/tasks/:taskId/checklist/items/:itemId", async (req, res) => {
    try {
      const user = await getActor(req);
      const task = await service.removeChecklistItem(req.params.taskId, req.params.itemId, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to delete checklist item");
    }
  });

  router.post("/tasks/:taskId/checklist/items/:itemId/checked", async (req, res) => {
    try {
      const { checked, note } = checklistItemCheckedSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.setChecklistItemChecked(req.params.taskId, req.params.itemId, checked, note, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to update checklist item");
    }
  });

  /* ONE note endpoint (#144). There were two — `/note` and `/checker-note` —
     which meant the client chose which field it wrote by choosing the URL, and
     nothing on the server checked that the choice matched the caller's seat.
     The service derives the field from the seat now, exactly as it already did
     for `addedBy`, so a note always carries the name of whoever wrote it. */
  router.post("/tasks/:taskId/checklist/items/:itemId/note", async (req, res) => {
    try {
      const { note } = checklistItemNoteSchema.parse(req.body);
      const user = await getActor(req);
      const task = await service.setChecklistItemNote(req.params.taskId, req.params.itemId, note, user);
      res.json({ task });
    } catch (error) {
      sendError(res, error, "Failed to set checklist item note");
    }
  });

  /* Share a task directly with one person from the dashboard (issue #41). DMs
     the target a bot card that deep-links to the task; the creator/assignee are
     not pinged. Validates the task and the target user both exist. */
  router.post("/tasks/:taskId/share", async (req, res) => {
    try {
      const actor = await getActor(req);
      const targetUserId =
        typeof (req.body as { targetUserId?: unknown }).targetUserId === "string"
          ? (req.body as { targetUserId: string }).targetUserId.trim()
          : "";
      const note =
        typeof (req.body as { note?: unknown }).note === "string"
          ? (req.body as { note: string }).note.trim()
          : "";
      if (!targetUserId) {
        res.status(400).json({ error: "targetUserId is required" });
        return;
      }
      const task = await service.getTask(req.params.taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      const target = await userStore.get(targetUserId);
      if (!target || target.active === false) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const { delivered } = await service.shareTask({
        taskId: task.id,
        target: { id: target.id, displayName: target.displayName },
        sharedBy: actor,
        ...(note ? { note } : {})
      });
      // The share always "succeeds" as an intent; `delivered` tells the UI
      // whether the DM actually reached them (issue #41).
      res.json({ ok: true, delivered });
    } catch (error) {
      sendError(res, error, "Failed to share task");
    }
  });

  /* Handoff (ADR-0002): point the task AT someone — this one does touch
     `assignee`, unlike /share above. Anyone authenticated may hand a task off;
     eligibility is enforced on the RECIPIENT (a Fraud Check only goes to a file
     checker), and the service rejects closed tasks, the task's own creator
     (ADR-0003), and whoever already holds it (#208). Validates that the task and
     the target user both exist, matching /share's shape. */
  router.post("/tasks/:taskId/assign", async (req, res) => {
    try {
      const actor = await getActor(req);
      const { assigneeUserId, note } = assignSchema.parse(req.body);
      const task = await service.getTask(req.params.taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      const target = await userStore.get(assigneeUserId);
      if (!target || target.active === false) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const updated = await service.assignTask({
        taskId: task.id,
        target,
        actor,
        ...(note?.trim() ? { note: note.trim() } : {})
      });
      res.json({ task: updated });
    } catch (error) {
      sendError(res, error, "Failed to assign task");
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
