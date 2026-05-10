import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import type { UserIdentity } from '@loancom/shared';
import { db } from './db/client.js';
import { users } from './db/schema.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserIdentity;
    }
  }
}

/**
 * Demo-mode auth: trust the `x-user-id` header. Production swap-in is Entra
 * OIDC bearer validation; the call sites and `req.user` shape stay identical.
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'missing x-user-id header' });
    return;
  }
  const row = db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) {
    res.status(401).json({ error: `unknown user ${userId}` });
    return;
  }
  req.user = {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
  next();
}

export function requireRole(...allowed: UserIdentity['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: `requires role: ${allowed.join('|')}` });
      return;
    }
    next();
  };
}
