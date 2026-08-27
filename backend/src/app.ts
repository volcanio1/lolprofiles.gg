import express, { Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
 *
 * ---------------------------------------------------------------------------
 * SERVING THE SINGLE-PAGE APP (`staticDir`)
 * ---------------------------------------------------------------------------
 *
 * The frontend is a history-mode SPA: `/profile`, `/test` and any future route
 * exist only in the browser's router, not as files. A static host that answers a
 * hard refresh of `/profile` by looking for `profile/index.html` returns its own
 * 404 — the app never loads. The fix is the standard SPA history fallback: every
 * request that is not `/api`, not `/health`, and not a real built file gets
 * `index.html`, and the browser router resolves the path from there.
 *
 * This is opt-in via `staticDir` (composition root reads `FRONTEND_DIST`). A
 * deployment that puts a CDN or reverse proxy in front of the API leaves it
 * unset and configures the fallback there instead — see the README.
 */
export interface CreateAppOptions extends ApiDependencies {
  /** Absolute path to the built frontend (`frontend/dist`). Omit to run API-only. */
  staticDir?: string;
}

export function createApp(deps: CreateAppOptions): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/api', createApiRouter(deps));

  if (deps.staticDir !== undefined) {
    const indexHtml = join(deps.staticDir, 'index.html');
    if (!existsSync(indexHtml)) {
      throw new Error(
        `staticDir "${deps.staticDir}" has no index.html. Build the frontend (npm run build:frontend) or unset FRONTEND_DIST.`,
      );
    }

    // Real files (hashed JS/CSS/assets) are immutable; index.html must always be
    // revalidated so a deploy is picked up without a hard refresh.
    app.use(
      express.static(deps.staticDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath === indexHtml) {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // History fallback: any GET that reached here is neither a real file (handled
    // just above) nor `/api` / `/health` (handled before). Hand it index.html and
    // let the browser router resolve the path — including to the in-app 404 page.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (req.path === '/health' || req.path === '/api' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  return app;
}
