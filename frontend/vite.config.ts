import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Dev server proxy for the backend API.
 *
 * The frontend dev server and the backend listen on different ports, so a direct
 * `fetch` from the browser to the backend is a CROSS-ORIGIN request. Because the
 * lookup request sends `Content-Type: application/json`, the browser issues a CORS
 * preflight first, and the backend answered it with no `Access-Control-Allow-Origin`
 * header — so every request was blocked before the backend saw it. No test could
 * catch this: the frontend tests inject `fetch` and the backend's tests use
 * supertest, neither of which enforces CORS.
 *
 * Proxying `/api` through the dev server makes those requests SAME-ORIGIN from the
 * browser's point of view, which fixes it without opening CORS at all. That is the
 * safer of the two available fixes: the lookup endpoint is unauthenticated and
 * spends the application's shared Riot rate-limit budget on a cache miss, so a
 * permissive `Access-Control-Allow-Origin` would let any page on the internet spend
 * that budget. The backend also supports an explicit origin allowlist
 * (`CORS_ALLOWED_ORIGINS`) for deployments that genuinely serve the frontend from a
 * different origin; this proxy means development does not need it.
 *
 * `apiBaseUrl` defaults to a relative empty base, so the built client requests
 * `/api/lookup` on its own origin and the proxy (dev) or the reverse proxy /
 * same-origin deployment (production) routes it onward.
 */
const BACKEND_ORIGIN = process.env.VITE_DEV_BACKEND_ORIGIN ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    // Test helpers are imported explicitly (no globals), matching the backend workspace.
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
