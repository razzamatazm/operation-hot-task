import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { buildRouter } from './routes.js';
import { seed } from './db/seed.js';

seed();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', buildRouter());

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`[loancom] api listening on http://localhost:${config.port}`);
  console.log(`[loancom] env=${config.nodeEnv} db=${config.databaseUrl}`);
});
