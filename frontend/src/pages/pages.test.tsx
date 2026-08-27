import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LookupOutcome, LookupRequest } from '../api/lookupClient';
import type { ProfileReport } from '../api/types';
import { RIOT_ATTRIBUTION_TEXT } from '../compliance/RiotDataPage';
import type { UseLookupOptions } from '../hooks/useLookup';
import { ProfileReportPage } from './ProfileReportPage';
import { SearchPage, reportPathFor } from './SearchPage';

/**
 * Task 16.3 — the search-to-report flow and the loading lifecycle, wired through
 * the real router. The lookup function is injected, so no network is touched.
 */

function sampleReport(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats: {
      rankedByQueue: { RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 50 } },
      overallAverageKda: 3.07,
      topChampions: [
        { championName: 'Vayne', gamesPlayed: 6, winRatePercent: 67, averageKda: 3.16, averageCs: 172.5, averageCsPerMinute: 5.75 },
      ],
      mostPlayedRole: 'BOTTOM',
    },
    funFacts: [{ category: 'rolePreference', text: 'Favourite role: BOTTOM.' }],
    limitedDataNotice: false,
    recommendations: [],
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

function renderApp(initialPath: string, lookupOptions?: UseLookupOptions) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/profile" element={<ProfileReportPage lookupOptions={lookupOptions} />} />
      </Routes>
    </MemoryRouter>,
  );
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
