import express, { type Express } from 'express';
import { createCheckInRouter } from './routes/check-in.js';
import type { CheckInService } from './services/check-in-service.js';

export interface AppDependencies {
  checkInService: CheckInService;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/check-ins', createCheckInRouter(deps.checkInService));

  return app;
}
