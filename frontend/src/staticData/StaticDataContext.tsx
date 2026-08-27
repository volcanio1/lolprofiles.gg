/**
 * Wires the Static Data Provider into React.
 *
 * Flow: ask the backend for the pinned version, look for a persisted index for that
 * exact version, and fetch Data Dragon's metadata only on a miss.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE BLOCKS RENDERING
 * ---------------------------------------------------------------------------
 *
 * Requirement 5.2 is that a Data Dragon failure leaves the report fully readable
 * with placeholders in place of images. So this component renders its children
 * immediately and unconditionally, on the first paint, with a provider that is not
 * yet ready. There is no loading gate, no suspense boundary and no error boundary,
 * because every one of those would turn a missing picture into a missing page.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `useStaticData()` OUTSIDE A PROVIDER RETURNS A NOT-READY PROVIDER RATHER THAN
 *    THROWING. The conventional "must be used within a Provider" throw would make
 *    an un-wrapped subtree crash instead of degrading, which is the same failure
 *    Requirement 5.2 rules out. A component rendered without the context simply
 *    shows placeholders.
 *
 * 2. THE FETCH IS NOT ROUTED THROUGH THE BACKEND. Data Dragon is a public CDN, not
 *    a rate-limited game API (Requirements 4.5, 4.6). Proxying it would add latency
 *    and bandwidth for no benefit, put CDN traffic through the Rate Limit Manager
 *    which does not govern it, and make the application a rehost of Riot's assets.
 *
 * 3. A LATE RESPONSE AFTER UNMOUNT IS DISCARDED. The 846 KB metadata fetch easily
 *    outlives a quick navigation, and setting state afterwards would warn in
 *    development and leak in principle.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiBaseUrl } from '../config';
import { readStoredIndex, writeStoredIndex } from './cache';
import {
  COMMUNITY_DRAGON_BASE,
  DDRAGON_BASE,
  buildStaticDataIndex,
  communityDragonVersionOf,
  createStaticDataProvider,
  type StaticDataIndex,
  type StaticDataProvider,
} from './provider';

/** Decision 1: a provider that answers everything with placeholders. */
const NOT_READY = createStaticDataProvider(null, null);

const StaticDataContext = createContext<StaticDataProvider>(NOT_READY);

export function useStaticData(): StaticDataProvider {
  return useContext(StaticDataContext);
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

/** Resolves the pinned version, then the index, without ever throwing to React. */
async function loadStaticData(
  signal: AbortSignal,
  now: () => number,
): Promise<{ version: string; index: StaticDataIndex | null }> {
  const versionBody = (await fetchJson(`${apiBaseUrl}/api/static-data`, signal)) as {
    dataDragonVersion?: unknown;
  };
  const version = versionBody?.dataDragonVersion;
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('Static data endpoint returned no version');
  }

  const stored = readStoredIndex(version, now());
  if (stored !== null) {
    return { version, index: stored };
  }

  // Decision 2: straight to the CDN, in parallel — the five files are independent.
  // Encoded for the same reason `provider.ts` encodes it into image URLs: the
  // value is our own backend's, but hardening it in one place and not the other is
  // how the unhardened path survives a later change to where it comes from.
  const cdn = `${DDRAGON_BASE}/cdn/${encodeURIComponent(version)}/data/en_US`;
  // `match-detail-tabs` Requirement 12.5: Community_Dragon, a SEPARATE CDN from
  // Data_Dragon, pinned to a derived {major}.{minor} — never Community_Dragon's
  // own "latest" alias.
  const cherryAugmentsUrl = `${COMMUNITY_DRAGON_BASE}/${encodeURIComponent(communityDragonVersionOf(version))}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json`;
  const [championJson, itemJson, summonerJson, runesJson, cherryAugmentsJson] = await Promise.all([
    fetchJson(`${cdn}/champion.json`, signal),
    fetchJson(`${cdn}/item.json`, signal),
    fetchJson(`${cdn}/summoner.json`, signal),
    fetchJson(`${cdn}/runesReforged.json`, signal),
    fetchJson(cherryAugmentsUrl, signal),
  ]);

  const index = buildStaticDataIndex(version, championJson, itemJson, summonerJson, runesJson, cherryAugmentsJson);
  writeStoredIndex(index, now());
  return { version, index };
}

export interface StaticDataContextProviderProps {
  children: ReactNode;
  /** Injected clock, matching how the rest of the application takes its time. */
  now?: () => number;
}

export function StaticDataContextProvider({
  children,
  now = Date.now,
}: StaticDataContextProviderProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [index, setIndex] = useState<StaticDataIndex | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true; // decision 3

    loadStaticData(controller.signal, now)
      .then((result) => {
        if (!active) {
          return;
        }
        setVersion(result.version);
        setIndex(result.index);
      })
      .catch(() => {
        // Requirement 5.2: the provider stays not-ready and every asset renders as
        // a placeholder. There is deliberately nothing to surface to the visitor —
        // the report is complete, it simply has no pictures.
      });

    return () => {
      active = false;
      controller.abort();
    };
    // `now` is an injected clock and is stable in every real use; re-running this
    // effect on a fresh inline function would re-fetch 846 KB on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = useMemo(
    () => createStaticDataProvider(version, index),
    [version, index],
  );

  return (
    <StaticDataContext.Provider value={provider}>{children}</StaticDataContext.Provider>
  );
}
