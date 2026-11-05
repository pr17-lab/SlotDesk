import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';

export const app = express();

app.use(helmet());

// Better Auth handler will go here in Step 5 before express.json()
app.use(express.json());

app.use('/api', healthRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
