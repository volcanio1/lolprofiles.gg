import { describe, expect, it } from 'vitest';
import { RateLimitExceededError, type RateLimitHeaders, type RateLimitManager } from '../rateLimit';
import type { RiotHttpRequestInit, RiotHttpResponse, RiotHttpTransport } from '../riotApiClient';
import { createHttpClashTournamentSource } from './tournamentSourceHttp';

function headers(values: Record<string, string> = {}): RateLimitHeaders {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function jsonResponse(status: number, body: unknown, responseHeaders: RateLimitHeaders = headers()): RiotHttpResponse {
  return { status, headers: responseHeaders, json: () => Promise.resolve(body) };
}

interface FakeManagerOptions {
  reserveSlotThrows?: unknown;
}

function fakeRateLimitManager(options: FakeManagerOptions = {}): {
  manager: RateLimitManager;
  reservations: { routingValue: string; method: string }[];
  headerReports: { routingValue: string; method: string }[];
} {
  const reservations: { routingValue: string; method: string }[] = [];
  const headerReports: { routingValue: string; method: string }[] = [];
  const manager: RateLimitManager = {
    reserveSlot: (routingValue, method) => {
      reservations.push({ routingValue, method });
      if (options.reserveSlotThrows !== undefined) {
        return Promise.reject(options.reserveSlotThrows);
      }
      return Promise.resolve();
    },
    recordResponseHeaders: (routingValue, method) => {
      headerReports.push({ routingValue, method });
    },
  };
  return { manager, reservations, headerReports };
}

function makeHarness(responses: RiotHttpResponse[], managerOptions: FakeManagerOptions = {}) {
  let index = 0;
  const calls: { url: string; init: RiotHttpRequestInit }[] = [];
  const transport: RiotHttpTransport = (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  };
  const { manager, reservations, headerReports } = fakeRateLimitManager(managerOptions);
  const sleeps: number[] = [];
  const source = createHttpClashTournamentSource({
    fetch: transport,
    apiKey: 'RGAPI-test',
    rateLimitManager: manager,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { source, calls, reservations, headerReports, sleeps };
}

describe('createHttpClashTournamentSource', () => {
  it('returns ok data for a 200, and requests the tournaments path with the API key header', async () => {
    const { source, calls } = makeHarness([jsonResponse(200, [{ id: 1 }])]);
    const result = await source.getClashTournaments('na1');
    expect(result).toEqual({ kind: 'ok', data: [{ id: 1 }] });
    expect(calls[0].url).toBe('https://na1.api.riotgames.com/lol/clash/v1/tournaments');
    expect(calls[0].init.headers['X-Riot-Token']).toBe('RGAPI-test');
  });

  it('reserves a rate-limit slot and reconciles response headers for every call', async () => {
    const { source, reservations, headerReports } = makeHarness([jsonResponse(200, [])]);
    await source.getClashTournaments('euw1');
    expect(reservations).toEqual([{ routingValue: 'euw1', method: expect.any(String) }]);
    expect(headerReports).toHaveLength(1);
    expect(headerReports[0].routingValue).toBe('euw1');
  });

  it('maps the >30s pre-flight refusal to rate_limited with no retryAfterSeconds', async () => {
    const { source } = makeHarness([jsonResponse(200, [])], {
      reserveSlotThrows: new RateLimitExceededError('na1', 'clashTournaments', 60_000),
    });
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'rate_limited' });
  });

  it('propagates a defect from reserveSlot that is not a RateLimitExceededError', async () => {
    const { source } = makeHarness([jsonResponse(200, [])], { reserveSlotThrows: new Error('boom') });
    await expect(source.getClashTournaments('na1')).rejects.toThrow('boom');
  });

  it('maps 404 to not_found', async () => {
    const { source } = makeHarness([jsonResponse(404, {})]);
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'not_found' });
  });

  it('maps 401/403 to auth_error', async () => {
    const { source } = makeHarness([jsonResponse(401, {})]);
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'auth_error', status: 401 });
  });

  it('maps 500-504 to server_error', async () => {
    const { source } = makeHarness([jsonResponse(503, {})]);
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'server_error', status: 503 });
  });

  it('retries a 429 up to MAX_RETRY_ATTEMPTS then succeeds, honoring Retry-After', async () => {
    const { source, calls, sleeps } = makeHarness([
      jsonResponse(429, {}, headers({ 'Retry-After': '2' })),
      jsonResponse(200, [{ id: 9 }]),
    ]);
    const result = await source.getClashTournaments('na1');
    expect(result).toEqual({ kind: 'ok', data: [{ id: 9 }] });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('gives up after MAX_RETRY_ATTEMPTS 429s and reports the last retryAfterSeconds', async () => {
    const { source, calls } = makeHarness([
      jsonResponse(429, {}, headers({ 'Retry-After': '1' })),
      jsonResponse(429, {}, headers({ 'Retry-After': '1' })),
      jsonResponse(429, {}, headers({ 'Retry-After': '3' })),
    ]);
    const result = await source.getClashTournaments('na1');
    expect(result).toEqual({ kind: 'rate_limited', retryAfterSeconds: 3 });
    expect(calls).toHaveLength(3);
  });

  it('maps a transport rejection to network_error', async () => {
    const transport: RiotHttpTransport = () => Promise.reject(new Error('DNS failure'));
    const { manager } = fakeRateLimitManager();
    const source = createHttpClashTournamentSource({ fetch: transport, apiKey: 'k', rateLimitManager: manager });
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'network_error' });
  });

  it('maps a fired timeout to timeout', async () => {
    // Mirrors `riotApiClient/index.test.ts`'s harness: the transport fires the
    // captured `onElapsed` synchronously (setting `timedOut`) before resolving
    // normally — `attempt()` checks `timedOut` after the await, regardless of
    // what the transport returned, so this does not need the transport to
    // actually honor the abort signal.
    let fire: () => void = () => undefined;
    const transport: RiotHttpTransport = () => {
      fire();
      return Promise.resolve(jsonResponse(200, []));
    };
    const { manager } = fakeRateLimitManager();
    const source = createHttpClashTournamentSource({
      fetch: transport,
      apiKey: 'k',
      rateLimitManager: manager,
      scheduleTimeout: (_ms, onElapsed) => {
        fire = onElapsed;
        return () => undefined;
      },
    });
    expect(await source.getClashTournaments('na1')).toEqual({ kind: 'timeout' });
  });
});
