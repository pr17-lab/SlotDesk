import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import {
  publicBookingLimiter,
  publicRequestLimiter,
  requestLimiter,
  writeLimiter,
} from './middleware/rate-limit.js';
import { healthRouter } from './routes/health.js';
import { orgsRouter } from './routes/orgs.js';
import { publicRouter } from './routes/public.js';

export const app = express();

app.use(helmet());

app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json({ limit: '10kb' }));

app.use('/api', healthRouter);
// The limits come first, so a flood is refused before the origin check, the
// session lookup or any database query. The write limiter goes last so its
// headers show on writes, where it is the tighter one.
app.use('/api/orgs', requestLimiter, writeLimiter, orgsRouter);
// The public booking page: no session, its own counts, and bookings limited
// per hour. Kept apart from /api/orgs so a staff route can't become public.
app.use(
  '/api/public',
  publicRequestLimiter,
  publicBookingLimiter,
  publicRouter,
);

// The built React app, if there is one. React Router handles page paths, so
// any other GET gets index.html, except /api paths (D-019). Express ignores
// case in routes, so the /api check does too. '/*splat' would miss '/'.
if (existsSync(path.join(config.clientDistDir, 'index.html'))) {
  app.use(express.static(config.clientDistDir));
  app.get('/{*splat}', (req, res, next) => {
    if (/^\/api/i.test(req.path)) {
      next();
      return;
    }
    res.sendFile('index.html', { root: config.clientDistDir });
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
