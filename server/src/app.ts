import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';
import { orgsRouter } from './routes/orgs.js';

export const app = express();

app.use(helmet());

app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json({ limit: '10kb' }));

app.use('/api', healthRouter);
app.use('/api/orgs', orgsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
