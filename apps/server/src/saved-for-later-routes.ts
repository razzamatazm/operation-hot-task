import { Request, Response, Router } from "express";
import type { UserIdentity } from "@loan-tasks/shared";
import { ZodError } from "zod";
import { AuthError } from "./auth.js";
import { SavedForLaterStore } from "./saved-for-later-store.js";
import { savedForLaterBodySchema } from "./validation.js";

/* The Saved for Later routes (#343, ADR-0011). A module of its own so what it
   can reach is visible in its imports: the caller's identity, the store and the
   body's shape, and nothing else. No task service, loan service, SSE hub, bot or
   notifier, which is how saving one is guaranteed to notify nobody, post
   nothing, broadcast nothing and touch no task or loan.
   `scripts/saved-for-later-sim-test.mjs` holds the import list to that.

   Every route answers for the caller only. Anyone else's, admins included,
   is a 404 rather than a 403: a refusal would confirm that one exists. */
const send = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: "That isn't a new task form" });
    return;
  }
  res.status(500).json({ error: fallback });
};

export const savedForLaterRoutes = (
  router: Router,
  getActor: (req: Request) => Promise<UserIdentity>,
  store: SavedForLaterStore
): void => {
  router.get("/saved-for-later", async (req, res) => {
    try {
      const actor = await getActor(req);
      res.json({ items: await store.list(actor.id) });
    } catch (error) {
      send(res, error, "Failed to load Saved for Later tasks");
    }
  });

  router.get("/saved-for-later/:id", async (req, res) => {
    try {
      const actor = await getActor(req);
      const item = await store.find(actor.id, req.params.id);
      if (!item) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ item });
    } catch (error) {
      send(res, error, "Failed to load Saved for Later task");
    }
  });

  /* Save a new task for later. Identity first, so a deactivated or unknown
     caller is refused before their body is even read. */
  router.post("/saved-for-later", async (req, res) => {
    try {
      const actor = await getActor(req);
      const { form } = savedForLaterBodySchema.parse(req.body);
      res.status(201).json({ item: await store.create(actor.id, form) });
    } catch (error) {
      send(res, error, "Failed to save for later");
    }
  });

  /* Save a reopened one for later again (#344). The same record, the whole new
     form, and the latest save wins: no version check and no conflict answer. */
  router.put("/saved-for-later/:id", async (req, res) => {
    try {
      const actor = await getActor(req);
      const { form } = savedForLaterBodySchema.parse(req.body);
      const item = await store.update(actor.id, req.params.id, form);
      if (!item) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ item });
    } catch (error) {
      send(res, error, "Failed to save for later");
    }
  });

  /* Remove one (#344). The web app calls this once the task it held has been
     created, and only then, so a filing that fails leaves it where it was. The
     task itself is filed through POST /tasks like any other, which is why this
     module never needs to reach the task service. */
  router.delete("/saved-for-later/:id", async (req, res) => {
    try {
      const actor = await getActor(req);
      if (!(await store.remove(actor.id, req.params.id))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      send(res, error, "Failed to remove Saved for Later task");
    }
  });
};
