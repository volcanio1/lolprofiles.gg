import express, { Express } from 'express';
import { createApiRouter, type ApiDependencies } from './api';

/**
 * Builds the Express application.
 *
 * Dependencies are REQUIRED rather than optional: an app assembled without an
 * orchestrator would still start and still serve `/health`, but every lookup would
 * 404 with no indication of why. Making them mandatory turns that into a compile
 * error instead of a runtime mystery.
 *
 * Constructing the real dependency graph — cache store, rate limit manager, Riot
 * API client with the configured key, orchestrator — belongs to the composition
 * root in `index.ts` (task 18.1), not here. This function only assembles routes.
 */
export function createApp(deps: ApiDependencies): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/api', createApiRouter(deps));

  return app;
}
