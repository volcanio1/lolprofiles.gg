/**
 * The concrete `ClashTournamentSource` — the one caller of Clash-V1's
 * tournaments endpoint (10/min), reachable only from the Tournament Refresher.
 *
 * Deliberately NOT a method on `HttpRiotApiClient` (see `tournamentSource.ts`):
 * this module duplicates a small slice of that class's request machinery —
 * the timeout, the rate-limit reservation, the bounded 429 retry — rather than
 * exposing `send()` for reuse, so that duplication is the price of keeping the
 * boundary a compile-time fact instead of a naming convention. It reuses the
 * same constants and injected-collaborator types `riotApiClient/index.ts`
 * exports (`API_KEY_HEADER`, `REQUEST_TIMEOUT_MS`, `DEFAULT_RETRY_AFTER_SECONDS`,
 * `MAX_RETRY_ATTEMPTS`, `parseRetryAfterSeconds`, `RiotHttpTransport`,
 * `RiotHttpRequestInit`, `RiotHttpResponse`, `TimeoutScheduler`) so the two
 * request policies cannot silently drift apart (Requirement 1.6: "the same
 * 10-second per-call timeout, rate-limit reservation, and 429 retry policy as
 * every other Riot API call").
 */

import {
  RateLimitExceededError,
  readHeader,
  type RateLimitManager,
} from '../rateLimit';
import {
  API_KEY_HEADER,
  DEFAULT_RETRY_AFTER_SECONDS,
  MAX_RETRY_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  parseRetryAfterSeconds,
  type RiotApiResult,
  type RiotHttpRequestInit,
  type RiotHttpResponse,
  type RiotHttpTransport,
  type TimeoutScheduler,
} from '../riotApiClient';
import type { PlatformRoutingValue } from '../region';
import type { ClashTournamentSource } from './tournamentSource';
import type { ClashTournamentDto } from './types';

const RIOT_HOST_SUFFIX = 'api.riotgames.com';
/** Stable rate-limit method identifier, kept local rather than in `RIOT_METHODS` — see module docblock. */
const CLASH_TOURNAMENTS_METHOD = 'clashTournaments';

export interface HttpClashTournamentSourceOptions {
  fetch: RiotHttpTransport;
  apiKey: string;
  rateLimitManager: RateLimitManager;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  scheduleTimeout?: TimeoutScheduler;
}

const defaultTimeoutScheduler: TimeoutScheduler = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  return () => {
    clearTimeout(handle);
  };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isAbortReason(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) {
    return false;
  }
  const name = (reason as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function createHttpClashTournamentSource(options: HttpClashTournamentSourceOptions): ClashTournamentSource {
  const transport = options.fetch;
  const apiKey = options.apiKey;
  const rateLimitManager = options.rateLimitManager;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;

  async function attempt(
    url: string,
    platform: PlatformRoutingValue,
  ): Promise<
    | { kind: 'response'; result: RiotApiResult<ClashTournamentDto[]>; status: number; retryAfterSeconds?: number }
    | { kind: 'aborted' }
    | { kind: 'failed' }
  > {
    const controller = new AbortController();
    let timedOut = false;
    const cancelTimeout = scheduleTimeout(timeoutMs, () => {
      timedOut = true;
      controller.abort();
    });

    let response: RiotHttpResponse;
    try {
      const init: RiotHttpRequestInit = {
        method: 'GET',
        headers: { [API_KEY_HEADER]: apiKey },
        signal: controller.signal,
      };
      response = await transport(url, init);
    } catch (error) {
      return timedOut || isAbortReason(error) ? { kind: 'aborted' } : { kind: 'failed' };
    } finally {
      cancelTimeout();
    }

    if (timedOut) {
      return { kind: 'aborted' };
    }

    // Requirement 4.3 (shared with `HttpRiotApiClient`): reconcile the tracked
    // window with what Riot reported, for every response including errors.
    rateLimitManager.recordResponseHeaders(platform, CLASH_TOURNAMENTS_METHOD, response.headers);

    const status = response.status;

    if (status === 200) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { kind: 'response', result: { kind: 'server_error', status: 502 }, status };
      }
      return { kind: 'response', result: { kind: 'ok', data: data as ClashTournamentDto[] }, status };
    }
    if (status === 404) {
      return { kind: 'response', result: { kind: 'not_found' }, status };
    }
    if (status === 429) {
      return {
        kind: 'response',
        result: { kind: 'rate_limited' },
        status,
        retryAfterSeconds: parseRetryAfterSeconds(readHeader(response.headers, 'Retry-After')),
      };
    }
    if (status === 401 || status === 403) {
      return { kind: 'response', result: { kind: 'auth_error', status }, status };
    }
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return { kind: 'response', result: { kind: 'server_error', status }, status };
    }
    return { kind: 'response', result: { kind: 'server_error', status: 502 }, status };
  }

  async function getClashTournaments(platform: PlatformRoutingValue): Promise<RiotApiResult<ClashTournamentDto[]>> {
    const url = `https://${platform}.${RIOT_HOST_SUFFIX}/lol/clash/v1/tournaments`;
    let lastRetryAfterSeconds: number | undefined;

    for (let attemptCount = 0; ; attemptCount += 1) {
      try {
        await rateLimitManager.reserveSlot(platform, CLASH_TOURNAMENTS_METHOD);
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          return { kind: 'rate_limited' };
        }
        throw error;
      }

      const outcome = await attempt(url, platform);

      if (outcome.kind === 'aborted') {
        return { kind: 'timeout' };
      }
      if (outcome.kind === 'failed') {
        return { kind: 'network_error' };
      }

      if (outcome.status !== 429) {
        return outcome.result;
      }

      lastRetryAfterSeconds = outcome.retryAfterSeconds;
      if (attemptCount >= MAX_RETRY_ATTEMPTS) {
        return { kind: 'rate_limited', retryAfterSeconds: lastRetryAfterSeconds };
      }
      await sleep((lastRetryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000);
    }
  }

  return { getClashTournaments };
}
