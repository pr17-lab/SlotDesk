import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';

export const app = express();

app.use(helmet());

app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json());

app.use('/api', healthRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
