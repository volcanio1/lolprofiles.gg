import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LookupOutcome, LookupRequest } from '../api/lookupClient';
import type { ProfileReport } from '../api/types';
import { perQueueReportFields } from '../test/reportExtras';
import { RIOT_ATTRIBUTION_TEXT } from '../compliance/RiotDataPage';
import type { UseLookupOptions } from '../hooks/useLookup';
import { ProfileReportPage } from './ProfileReportPage';
import { SearchPage, reportPathFor } from './SearchPage';

/**
 * Task 16.3 — the search-to-report flow and the loading lifecycle, wired through
 * the real router. The lookup function is injected, so no network is touched.
 */

function sampleReport(overrides: Partial<ProfileReport> = {}): ProfileReport {
  const stats = {
    rankedByQueue: { RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 50, leaguePoints: 50 } },
    overallAverageKda: 3.07,
    topChampions: [
      { championName: 'Vayne', gamesPlayed: 6, winRatePercent: 67, averageKda: 3.16, averageCs: 172.5, averageCsPerMinute: 5.75 },
    ],
    mostPlayedRole: 'BOTTOM',
    averageMatchDurationMinutes: 28.5,
  };
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats,
    ...perQueueReportFields(stats),
    championMastery: [],
    funFacts: [],
    limitedDataNotice: false,
    performanceFeedback: [],
    averageMatchDurationMinutes: 30.38,
    recentMatches: [],
    lastUpdated: null,
    partialDataWarning: false,
    ...overrides,
  };
}

/** Shows the current location, so navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderApp(
  initialPath: string,
  lookupOptions?: UseLookupOptions,
  fetchCachedReport?: typeof import('../api/lookupClient').fetchCachedReport,
  { strict = false }: { strict?: boolean } = {},
) {
  const tree = (
    <HelmetProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route
            path="/profile"
            element={<ProfileReportPage lookupOptions={lookupOptions} fetchCachedReport={fetchCachedReport} />}
          />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('reportPathFor — the deferred #-in-URL decision', () => {
  it('percent-encodes the # so the Riot ID survives the round trip', () => {
    const path = reportPathFor({ riotId: 'Doffy#Smile' });

    expect(path).toContain('riotId=Doffy%23Smile');
    // The fragment delimiter must not appear raw, or everything after it is lost.
    expect(path.split('?')[1]).not.toContain('#');
  });

  it('round-trips the Riot ID through URLSearchParams unchanged', () => {
    const path = reportPathFor({ riotId: 'Doffy#Smile' });
    const params = new URLSearchParams(path.split('?')[1]);

    expect(params.get('riotId')).toBe('Doffy#Smile');
  });

  it('never includes a region or platform query parameter (lookup-pipeline-fixes Requirement 2.1)', () => {
    const path = reportPathFor({ riotId: 'A#B' });
    expect(path).not.toContain('region');
    expect(path).not.toContain('platform');
  });

  it('encodes Riot IDs containing characters that are significant in a URL', () => {
    const params = new URLSearchParams(reportPathFor({ riotId: 'a b&c#d+e' }).split('?')[1]);
    expect(params.get('riotId')).toBe('a b&c#d+e');
  });
});

describe('SearchPage — Requirement 1.1/1.2', () => {
  it('navigates to the report route with the submitted Riot ID', async () => {
    const user = userEvent.setup();
    renderApp('/');

    await user.type(screen.getByLabelText('Riot ID'), 'Doffy#Smile');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/profile');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('riotId=Doffy%23Smile');
  });

  it('does not navigate when validation fails (Requirement 9.1)', async () => {
    const user = userEvent.setup();
    renderApp('/');

    await user.type(screen.getByLabelText('Riot ID'), 'Doffy');
    await user.click(screen.getByRole('button', { name: /search/i }));

    expect(screen.getByTestId('location')).toHaveTextContent('/');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('carries the Riot attribution (Requirement 12.1)', () => {
    renderApp('/');
    expect(screen.getByTestId('riot-attribution')).toHaveTextContent(RIOT_ATTRIBUTION_TEXT);
  });
});

describe('ProfileReportPage — loading lifecycle (Requirements 9.6, 9.7)', () => {
  it('shows the indicator while in flight and removes it on success', async () => {
    let resolve: ((outcome: LookupOutcome) => void) | undefined;
    const lookup = () =>
      new Promise<LookupOutcome>((r) => {
        resolve = r;
      });

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });

    resolve?.({ kind: 'success', report: sampleReport() });

    await waitFor(() => {
      expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('profile-report')).toBeInTheDocument();
  });

  it('sets the document title to the Riot ID once the report loads (SEO)', async () => {
    const lookup = () => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(document.title).toBe('Doffy#Smile — lolprofiles.gg');
    });
  });

  it('removes the indicator on an error too', async () => {
    const lookup = () =>
      Promise.resolve<LookupOutcome>({
        kind: 'error',
        error: { code: 'TIMEOUT', message: 'The lookup timed out.', retriable: false },
      });

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(screen.getByTestId('error-notice')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-report')).not.toBeInTheDocument();
  });
});

describe('ProfileReportPage — request derived from the URL', () => {
  it('decodes the Riot ID from the URL and dispatches only that (lookup-pipeline-fixes Requirement 2.1)', async () => {
    const calls: LookupRequest[] = [];
    const lookup = (request: LookupRequest) => {
      calls.push(request);
      return Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
    };

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({ riotId: 'Doffy#Smile' });
  });

  it('ignores a region or platform query parameter left over from an old link', async () => {
    const calls: LookupRequest[] = [];
    const lookup = (request: LookupRequest) => {
      calls.push(request);
      return Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
    };

    renderApp('/profile?riotId=Doffy%23Smile&region=atlantis&platform=euw1', { lookup });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({ riotId: 'Doffy#Smile' });
  });

  it('dispatches nothing and prompts when the URL carries no Riot ID', async () => {
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));

    renderApp('/profile', { lookup });

    await waitFor(() => {
      expect(screen.getByTestId('no-riot-id-prompt')).toBeInTheDocument();
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.queryByTestId('error-notice')).not.toBeInTheDocument();
  });

  it('prefills the Riot ID from the URL so correcting a typo is one interaction', async () => {
    const lookup = () => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(screen.getByLabelText('Riot ID')).toHaveValue('Doffy#Smile');
    });
  });

  it('re-runs the lookup when the form is resubmitted with a different Riot ID', async () => {
    const user = userEvent.setup();
    const calls: LookupRequest[] = [];
    const lookup = (request: LookupRequest) => {
      calls.push(request);
      return Promise.resolve<LookupOutcome>({
        kind: 'error',
        error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true },
      });
    };

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({ riotId: 'Doffy#Smile' });

    await user.clear(screen.getByLabelText('Riot ID'));
    await user.type(screen.getByLabelText('Riot ID'), 'Other#Smile');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]).toEqual({ riotId: 'Other#Smile' });
  });
});

describe('ProfileReportPage — error handling and retry (Requirements 9.3, 9.8)', () => {
  it('retries the lookup on explicit visitor action', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const lookup = () => {
      attempts += 1;
      return Promise.resolve<LookupOutcome>(
        attempts === 1
          ? { kind: 'error', error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true } }
          : { kind: 'success', report: sampleReport() },
      );
    };

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(screen.getByTestId('retry-button')).toBeEnabled();
    });
    await user.click(screen.getByTestId('retry-button'));

    await waitFor(() => {
      expect(screen.getByTestId('profile-report')).toBeInTheDocument();
    });
    expect(attempts).toBe(2);
    expect(screen.queryByTestId('error-notice')).not.toBeInTheDocument();
  });

  it('shows the not-found state without offering a retry', async () => {
    const lookup = () =>
      Promise.resolve<LookupOutcome>({
        kind: 'error',
        error: {
          code: 'PLAYER_NOT_FOUND',
          message: 'No player was found for the Riot ID Doffy#Smile.',
          retriable: false,
          gameName: 'Doffy',
          tagLine: 'Smile',
        },
      });

    renderApp('/profile?riotId=Doffy%23Smile', { lookup });

    await waitFor(() => {
      expect(screen.getByTestId('error-notice')).toBeInTheDocument();
    });
    expect(screen.getByTestId('error-message')).toHaveTextContent('Doffy#Smile');
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });
});

describe('ProfileReportPage — compliance (Requirements 12.1, 12.2)', () => {
  it('carries the attribution and no advertising slot in every state', async () => {
    const states: LookupOutcome[] = [
      { kind: 'success', report: sampleReport() },
      { kind: 'error', error: { code: 'RIOT_UNAVAILABLE', message: 'down', retriable: true } },
    ];

    for (const outcome of states) {
      const { unmount } = renderApp('/profile?riotId=Doffy%23Smile', {
        lookup: () => Promise.resolve(outcome),
      });

      await waitFor(() => {
        expect(screen.getByTestId('riot-attribution')).toHaveTextContent(RIOT_ATTRIBUTION_TEXT);
      });
      expect(screen.queryByTestId('advertising-slot')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('ProfileReportPage — autofill-search cached report + refresh (Requirements 9, 10)', () => {
  const cacheHit = (fetchedAtIso: string) =>
    vi.fn(() => Promise.resolve({ source: 'cache' as const, report: sampleReport(), fetchedAt: fetchedAtIso }));
  const cacheMiss = () => vi.fn(() => Promise.resolve({ source: 'miss' as const }));

  it('renders a snapshot on a suggestion selection without any live lookup, then strips src', async () => {
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));
    const fetchCachedReport = cacheHit('2026-08-20T00:00:00.000Z');

    renderApp('/profile?riotId=Doffy%23Smile&src=suggest', { lookup }, fetchCachedReport);

    await waitFor(() => {
      expect(screen.getByTestId('profile-report')).toBeInTheDocument();
    });
    expect(fetchCachedReport).toHaveBeenCalledWith('Doffy', 'Smile');
    expect(lookup).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('src=suggest');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('riotId=Doffy%23Smile');
  });

  it('still dispatches under React StrictMode (double-invoked effects must not blank the page)', async () => {
    const lookupHit = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));
    const cacheHitFn = cacheHit('2026-08-20T00:00:00.000Z');
    renderApp('/profile?riotId=Doffy%23Smile&src=suggest', { lookup: lookupHit }, cacheHitFn, { strict: true });
    await waitFor(() => {
      expect(screen.getByTestId('profile-report')).toBeInTheDocument();
    });
    expect(lookupHit).not.toHaveBeenCalled();

    const lookupMiss = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));
    renderApp('/profile?riotId=Doffy%23Smile', { lookup: lookupMiss }, cacheMiss(), { strict: true });
    await waitFor(() => {
      expect(lookupMiss).toHaveBeenCalled();
    });
  });

  it('shows a loading animation while the cached-report probe is in flight', async () => {
    let resolve: ((r: { source: 'miss' }) => void) | undefined;
    const fetchCachedReport = vi.fn(
      () => new Promise<{ source: 'miss' }>((r) => { resolve = r; }),
    );
    const lookup = () =>
      new Promise<LookupOutcome>(() => undefined); // never settles

    renderApp('/profile?riotId=Doffy%23Smile&src=suggest', { lookup }, fetchCachedReport);

    await waitFor(() => {
      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('profile-report')).not.toBeInTheDocument();

    resolve?.({ source: 'miss' });
    await waitFor(() => {
      // still loading — now the live lookup is in flight
      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });
  });

  it('dims the report and shows a loader while a refresh is in flight', async () => {
    let clock = 1_000_000;
    const pending: { at: number; run: () => void }[] = [];
    const schedule = (ms: number, run: () => void) => {
      const entry = { at: clock + ms, run };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    };
    const advance = async (ms: number) => {
      clock += ms;
      await act(async () => {
        for (const e of pending.filter((p) => p.at <= clock)) e.run();
        await Promise.resolve();
      });
    };

    let resolveRefresh: ((o: LookupOutcome) => void) | undefined;
    let call = 0;
    const lookup = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() });
      return new Promise<LookupOutcome>((r) => { resolveRefresh = r; });
    });

    renderApp('/profile?riotId=Doffy%23Smile', { lookup, now: () => clock, schedule }, cacheMiss());

    await waitFor(() => expect(screen.getByTestId('profile-report')).toBeInTheDocument());
    await advance(6 * 60 * 1000);
    await waitFor(() => expect(screen.getByTestId('refresh-button')).toBeEnabled());

    const user = userEvent.setup();
    await user.click(screen.getByTestId('refresh-button'));

    await waitFor(() => {
      expect(screen.getByTestId('loading-indicator')).toHaveTextContent('Refreshing');
    });
    expect(screen.getByTestId('profile-report').parentElement).toHaveClass('report-refreshing');
    expect(lookup).toHaveBeenCalledTimes(2);

    resolveRefresh?.({ kind: 'success', report: sampleReport({ summonerLevel: 999 }) });
    await waitFor(() => {
      expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
    });
  });

  it('falls through to a live lookup when the snapshot misses', async () => {
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));
    const fetchCachedReport = cacheMiss();

    renderApp('/profile?riotId=Doffy%23Smile&src=suggest', { lookup }, fetchCachedReport);

    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(lookup).toHaveBeenCalledWith({ riotId: 'Doffy#Smile' });
    expect(screen.getByTestId('profile-report')).toBeInTheDocument();
  });

  it('never consults the cached-report endpoint for a hand-typed Riot ID', async () => {
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));
    const fetchCachedReport = cacheMiss();

    renderApp('/profile?riotId=Doffy%23Smile', { lookup }, fetchCachedReport);

    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });
    expect(fetchCachedReport).not.toHaveBeenCalled();
  });

  it('shows the Refresh control on every report and re-runs the lookup once the cooldown has passed', async () => {
    const reports = [sampleReport({ summonerLevel: 1 }), sampleReport({ summonerLevel: 2 })];
    let call = 0;
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: reports[call++] ?? reports[1] }));

    let clock = 1_000_000;
    const pending: { at: number; run: () => void }[] = [];
    const schedule = (ms: number, run: () => void) => {
      const entry = { at: clock + ms, run };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    };
    const advance = async (ms: number) => {
      clock += ms;
      await act(async () => {
        for (const e of pending.filter((p) => p.at <= clock)) e.run();
        await Promise.resolve();
      });
    };

    renderApp('/profile?riotId=Doffy%23Smile', { lookup, now: () => clock, schedule }, cacheMiss());

    await waitFor(() => {
      expect(screen.getByTestId('refresh-button')).toBeDisabled(); // inside the cooldown
    });

    await advance(6 * 60 * 1000); // past REFRESH_COOLDOWN_MS
    await waitFor(() => {
      expect(screen.getByTestId('refresh-button')).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('refresh-button'));

    await waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  });

  it('disables Refresh within the cooldown window of a freshly fetched report', async () => {
    const clock = 1_000_000;
    const lookup = vi.fn(() => Promise.resolve<LookupOutcome>({ kind: 'success', report: sampleReport() }));

    renderApp('/profile?riotId=Doffy%23Smile', { lookup, now: () => clock }, cacheMiss());

    await waitFor(() => {
      expect(screen.getByTestId('refresh-button')).toBeInTheDocument();
    });
    // The report just landed at `clock`, so it is inside REFRESH_COOLDOWN_MS.
    expect(screen.getByTestId('refresh-button')).toBeDisabled();
  });
});
