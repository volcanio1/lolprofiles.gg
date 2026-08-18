import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createInMemoryCacheStore } from '../cache';
import type { LookupOrchestrator } from '../orchestrator';
import { createApiRouter } from './index';
import { parseAllowedOrigins } from './cors';

/**
 * Cross-origin behavior, driven through the real Express stack.
 *
 * These tests exist because nothing in the suite could previously catch a CORS
 * failure: the frontend tests inject `fetch` and supertest does not enforce CORS, so
 * a browser-blocking misconfiguration was invisible until a real browser tried it.
 * Supertest still does not *enforce* anything — but it does let us assert the
 * headers a browser would enforce on.
 */

const ALLOWED = 'https://lolprofiles.gg';
const OTHER = 'https://evil.example';

const stubOrchestrator: LookupOrchestrator = {
  runLookup: () => Promise.resolve({ kind: 'error', code: 'RIOT_UNAVAILABLE', retriable: true }),
};

function makeApp(allowedOrigins?: readonly string[]) {
  const now = () => 1_000;
  const app = express();
  app.use(
    '/api',
    createApiRouter({
      orchestrator: stubOrchestrator,
      cache: createInMemoryCacheStore({ now }),
      now,
      logger: { unexpectedError: () => undefined },
      allowedOrigins,
    }),
  );
  return app;
}

describe('parseAllowedOrigins', () => {
  it('reads a comma-separated list', () => {
    expect(parseAllowedOrigins('https://a.example,https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('trims whitespace and strips trailing slashes, which an Origin header never has', () => {
    expect(parseAllowedOrigins(' https://a.example/ , https://b.example//  ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('treats absent, blank and empty entries as no origins', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
    expect(parseAllowedOrigins(',,')).toEqual([]);
  });
});

describe('default configuration — no allowlist', () => {
  it('sends no CORS headers at all, so browsers refuse cross-origin calls', async () => {
    const response = await request(makeApp())
      .post('/api/lookup')
      .set('Origin', ALLOWED)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    // The request itself is still served; CORS is enforced by the browser, not here.
    expect(response.status).toBe(503);
  });

  it('still serves same-origin and non-browser callers normally', async () => {
    const response = await request(makeApp()).post('/api/lookup').send({ riotId: 'Doffy#Smile' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('RIOT_UNAVAILABLE');
  });
});

describe('an allowed origin', () => {
  it('answers the preflight with 204 and the headers a browser requires', async () => {
    const response = await request(makeApp([ALLOWED]))
      .options('/api/lookup')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    // Express's default OPTIONS handler answers 200 with `Allow: POST` and NO CORS
    // headers, which looks like success and fails the preflight. This must not.
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('echoes the origin on the actual response', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/lookup')
      .set('Origin', ALLOWED)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.status).toBe(503);
  });

  it('sets Vary: Origin so a shared cache cannot cross-serve the headers', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/lookup')
      .set('Origin', ALLOWED)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers.vary).toContain('Origin');
  });

  it('never allows credentials, since the API uses none', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/lookup')
      .set('Origin', ALLOWED)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('covers the privacy route too', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/privacy/delete')
      .set('Origin', ALLOWED)
      .send({ puuid: 'p-1' });

    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.status).toBe(200);
  });
});

describe('a disallowed origin', () => {
  it('receives no allow-origin header, so the browser blocks the response', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/lookup')
      .set('Origin', OTHER)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not get a successful preflight', async () => {
    const response = await request(makeApp([ALLOWED]))
      .options('/api/lookup')
      .set('Origin', OTHER)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.status).not.toBe(204);
  });

  it('is matched exactly — no substring, scheme or subdomain slack', async () => {
    for (const origin of [
      'https://lolprofiles.gg.evil.example',
      'http://lolprofiles.gg',
      'https://sub.lolprofiles.gg',
      'https://LOLPROFILES.GG',
    ]) {
      const response = await request(makeApp([ALLOWED]))
        .post('/api/lookup')
        .set('Origin', origin)
        .send({ riotId: 'Doffy#Smile' });

      expect(response.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('never reflects an arbitrary origin, which would be a wildcard in disguise', async () => {
    const response = await request(makeApp([ALLOWED]))
      .post('/api/lookup')
      .set('Origin', OTHER)
      .send({ riotId: 'Doffy#Smile' });

    expect(response.headers['access-control-allow-origin']).not.toBe(OTHER);
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('multiple allowed origins', () => {
  it('allows each one it was given, and nothing else', async () => {
    const app = makeApp([ALLOWED, 'https://staging.lolprofiles.gg']);

    for (const origin of [ALLOWED, 'https://staging.lolprofiles.gg']) {
      const response = await request(app).post('/api/lookup').set('Origin', origin).send({ riotId: 'A#B' });
      expect(response.headers['access-control-allow-origin'], origin).toBe(origin);
    }

    const blocked = await request(app).post('/api/lookup').set('Origin', OTHER).send({ riotId: 'A#B' });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
