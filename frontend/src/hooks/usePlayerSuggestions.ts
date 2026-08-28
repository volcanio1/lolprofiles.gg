/**
 * Debounced autocomplete suggestions for the search field
 * (specs/autofill-search/ Requirement 3).
 *
 * Given the current `gameName` prefix, it returns the suggestion list to show
 * beneath the input. It owns three concerns and nothing else:
 *
 *  - **Debounce (3.2).** A timer resets on every `query` change; the request
 *    fires only when it elapses. Below `MIN_QUERY_LENGTH` (or once the value
 *    contains a `#`) no timer is set and the list is emptied immediately.
 *  - **Stale-response rejection (3.4).** Each fetch runs under its own
 *    `AbortController`, aborted when the query changes or the component
 *    unmounts, and a monotonically increasing request id is checked on
 *    resolution so a response that races past the abort is still discarded.
 *  - **`clear()`** empties the list with no request — the caller uses it on
 *    selection and on Escape.
 *
 * It deliberately holds NO "is the dropdown open" state: whether the list is
 * shown is a render-time function of `suggestions.length`, input focus and a
 * local dismissed flag, all owned by `SearchForm`.
 *
 * ---------------------------------------------------------------------------
 * INJECTED DEFAULTS MUST BE REFERENTIALLY STABLE
 * ---------------------------------------------------------------------------
 *
 * Same hazard as `useLookup` decision 6: the debounce effect depends on
 * `fetchImpl` and `schedule`, so if a caller passes a fresh inline function
 * every render the effect re-runs every render. Both are resolved through
 * `useMemo` keyed on the injected value, so the production path (no options)
 * and a test that passes a stable ref are both safe. A caller passing an
 * unstable option is the misuse this note exists to flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSuggestions as defaultFetchSuggestions } from '../api/lookupClient';
import type { PlayerSuggestion } from '../api/types';
import { isAnswerableSuggestionQuery } from '../domain/suggestions';

/** specs/autofill-search/ design.md — idle time after the last keystroke before a request. */
export const SUGGESTION_DEBOUNCE_MS = 200;

export type SuggestionFetcher = (
  query: string,
  options: { signal?: AbortSignal },
) => Promise<PlayerSuggestion[]>;

/** Injected so tests never wait on real time. `(ms, run) => cancel`. */
export type DebounceScheduler = (ms: number, run: () => void) => () => void;

export interface UsePlayerSuggestionsOptions {
  fetchSuggestions?: SuggestionFetcher;
  schedule?: DebounceScheduler;
  debounceMs?: number;
}

export interface UsePlayerSuggestionsResult {
  suggestions: PlayerSuggestion[];
  /** Empties the list without issuing a request. */
  clear: () => void;
}

const defaultScheduler: DebounceScheduler = (ms, run) => {
  const handle = setTimeout(run, ms);
  return () => {
    clearTimeout(handle);
  };
};

export function usePlayerSuggestions(
  query: string,
  options: UsePlayerSuggestionsOptions = {},
): UsePlayerSuggestionsResult {
  const fetchImpl = useMemo<SuggestionFetcher>(
    () => options.fetchSuggestions ?? ((q, o) => defaultFetchSuggestions(q, o)),
    [options.fetchSuggestions],
  );
  const schedule = useMemo(() => options.schedule ?? defaultScheduler, [options.schedule]);
  const debounceMs = options.debounceMs ?? SUGGESTION_DEBOUNCE_MS;

  const [suggestions, setSuggestions] = useState<PlayerSuggestion[]>([]);

  /** Bumped on every dispatch, query change, unmount and `clear()`; a resolved fetch applies only if it still matches. */
  const requestId = useRef(0);
  const activeController = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeController.current?.abort();
      activeController.current = undefined;
    };
  }, []);

  const clear = useCallback(() => {
    requestId.current += 1;
    activeController.current?.abort();
    activeController.current = undefined;
    setSuggestions([]);
  }, []);

  const trimmed = query.trim();
  const answerable = isAnswerableSuggestionQuery(trimmed);

  useEffect(() => {
    if (!answerable) {
      // Requirement 3.2: no timer below the threshold; Requirement 3.4: cancel
      // anything in flight and drop what is shown right away.
      requestId.current += 1;
      activeController.current?.abort();
      activeController.current = undefined;
      setSuggestions([]);
      return undefined;
    }

    const cancelTimer = schedule(debounceMs, () => {
      requestId.current += 1;
      const dispatched = requestId.current;
      const controller = new AbortController();
      activeController.current = controller;

      void (async () => {
        let rows: PlayerSuggestion[];
        try {
          rows = await fetchImpl(trimmed, { signal: controller.signal });
        } catch {
          // `fetchSuggestions` never rejects; an injected fake might.
          return;
        }
        if (!mounted.current || dispatched !== requestId.current) {
          return;
        }
        setSuggestions(rows);
      })();
    });

    return () => {
      // Query changed (or effect re-ran): reset the debounce and invalidate any
      // request the previous query already started.
      cancelTimer();
      requestId.current += 1;
      activeController.current?.abort();
      activeController.current = undefined;
    };
  }, [trimmed, answerable, schedule, debounceMs, fetchImpl]);

  return useMemo(() => ({ suggestions, clear }), [suggestions, clear]);
}
