import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { attachClient } from './sse.js';
import {
  listFeed,
  listLoans,
  listUsers,
  loadRequest,
} from './workflow-service.js';

export function buildRouter(): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Mock-user selector helper — exposes the seeded identities. Demo only.
  r.get('/users', (_req, res) => {
    res.json({ users: listUsers() });
  });

  r.use(requireUser);

  r.get('/me', (req, res) => {
    res.json({ user: req.user });
  });

  r.get('/feed', (req, res) => {
    const parse = z
      .object({ status: z.string().optional() })
      .safeParse(req.query);
    if (!parse.success) {
      res.status(400).json({ error: parse.error.flatten() });
      return;
    }
    const items = listFeed({ status: parse.data.status as never });
    res.json({ items });
  });

  r.get('/requests/:id', (req, res) => {
    const item = loadRequest(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ request: item });
  });

  r.get('/loans', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ loans: listLoans(q) });
  });

  r.get('/stream', (req, res) => {
    attachClient(req, res);
  });

  return r;
}
