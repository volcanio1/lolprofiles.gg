import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ChampionBuild, ChampionBuildStats } from '../api/types';
import { emptyChampionBuildStats, type ChampionStatsFilters } from '../api/lookupClient';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import type { ChampionBuildStatsFetcher } from '../hooks/useChampionBuildStats';
import { ChampionBuildPage } from './ChampionBuildPage';

const VERSION = '16.17.1';
const CHAMPION_JSON = { data: { Jinx: { name: 'Jinx', image: { full: 'Jinx.png' } } } };

function fullBuild(overrides: Partial<ChampionBuild> = {}): ChampionBuild {
  return {
    matchCount: 4200,
    winRate: 0.512,
    pickRate: 0.34,
    coreItems: [3006, 3031, 3036],
    startingItems: null,
    skillOrder: { maxOrder: ['Q', 'W', 'E'], perLevel: [1, 3, 2] },
    runes: {
      primaryStyle: 8100,
      secondaryStyle: 8000,
      primarySelections: [8112, 8126, 8138, 8135],
      secondarySelections: [9111, 8014],
      statShards: [5008, 5008, 5001],
    },
    summonerSpells: [4, 7],
    ...overrides,
  };
}

function stats(overrides: Partial<ChampionBuildStats> = {}): ChampionBuildStats {
  const base = emptyChampionBuildStats('Jinx', {});
  return {
    ...base,
    champion: { key: 'Jinx', name: 'Jinx' },
    meta: {
      ...base.meta,
      patch: '16.17',
      lastUpdatedAt: 1_700_000_000_000,
      availableRoles: ['ALL', 'BOTTOM'],
      defaultRole: 'BOTTOM',
      availableRanks: ['ALL', 'EMERALD_PLUS'],
      availableRegions: ['world'],
      overall: { winRate: 0.53, pickRate: 0.22, totalGames: 12_000 },
      ...overrides.meta,
    },
    filtersApplied: { role: 'BOTTOM', rank: 'ALL', region: 'world', ...overrides.filtersApplied },
    popular: fullBuild(),
    highestWinRate: fullBuild({ winRate: 0.58 }),
    ...overrides,
  };
}

function Location() {
  return <span data-testid="loc">{`${useLocation().pathname}${useLocation().search}`}</span>;
}

function renderPage(
  path: string,
  fetcher: ChampionBuildStatsFetcher,
  { indexReady = true }: { indexReady?: boolean } = {},
) {
  const provider = indexReady
    ? createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }))
    : createStaticDataProvider(null, null);
  return render(
    <HelmetProvider>
      <StaticDataContext.Provider value={provider}>
        <MemoryRouter initialEntries={[path]}>
          <Location />
          <Routes>
            <Route
              path="/champion/:championKey"
              element={
                <ChampionBuildPage
                  championBuildStatsOptions={{ fetchChampionBuildStats: fetcher }}
                  now={() => 1_700_000_100_000}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </StaticDataContext.Provider>
    </HelmetProvider>,
  );
}

describe('ChampionBuildPage', () => {
  it('renders the unknown-champion state without a fetch (Requirement 3.2)', () => {
    const fetcher = vi.fn(async (_k: string, _f: ChampionStatsFilters): Promise<ChampionBuildStats> => stats());
    renderPage('/champion/NotAChamp', fetcher);
    expect(screen.getByTestId('unknown-champion')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shows a loading state before the static data index is ready (not "unknown")', () => {
    const fetcher = vi.fn(async (_k: string, _f: ChampionStatsFilters): Promise<ChampionBuildStats> => stats());
    renderPage('/champion/Jinx', fetcher, { indexReady: false });
    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    expect(screen.queryByTestId('unknown-champion')).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads filters from the URL and fetches with them', async () => {
    const fetcher = vi.fn(async (_k: string, _f: ChampionStatsFilters): Promise<ChampionBuildStats> => stats());
    renderPage('/champion/Jinx?role=BOTTOM&rank=EMERALD_PLUS', fetcher);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][1]).toMatchObject({ role: 'BOTTOM', rank: 'EMERALD_PLUS' });
  });

  it('renders both panels, the header figures and the freshness line', async () => {
    renderPage('/champion/Jinx', async () => stats());
    await screen.findByRole('region', { name: 'Most popular' });
    expect(screen.getByRole('region', { name: 'Highest win rate' })).toBeInTheDocument();
    expect(screen.getByTestId('champion-overall-win-rate')).toHaveTextContent('53.0% win rate');
    expect(screen.getByTestId('champion-overall-games')).toHaveTextContent('12,000 games');
    const freshness = screen.getByTestId('champion-build-freshness');
    expect(freshness).toHaveTextContent('Patch 16.17');
    expect(freshness).toHaveTextContent('updated 1m ago'); // now - lastUpdatedAt = 100_000 ms
    expect(freshness).toHaveTextContent('not Riot data');
    expect(screen.queryByTestId('champion-not-enough-data')).not.toBeInTheDocument();
  });

  it('drops a stale response after the filters change mid-flight (Requirement 4.3)', async () => {
    const user = userEvent.setup();
    const resolvers: ((s: ChampionBuildStats) => void)[] = [];
    const seenRanks: (string | undefined)[] = [];
    const fetcher: ChampionBuildStatsFetcher = (_key, filters) => {
      seenRanks.push(filters.rank);
      return new Promise((resolve) => resolvers.push(resolve));
    };
    renderPage('/champion/Jinx', fetcher);

    const withGames = (n: number) => stats({ meta: { ...stats().meta, overall: { winRate: 0.5, pickRate: 0.2, totalGames: n } } });

    // resolve the first request so the controls render
    await waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0](withGames(1000));
    await screen.findByRole('region', { name: 'Most popular' });

    // change rank -> a second request goes out
    await user.selectOptions(screen.getByTestId('champion-filter-rank'), 'EMERALD_PLUS');
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // resolve the OLD request last — it must be ignored
    resolvers[1]?.(withGames(2222));
    resolvers[0](withGames(9999));

    await waitFor(() => {
      expect(screen.getByTestId('champion-overall-games')).toHaveTextContent('2,222 games');
    });
    expect(screen.getByTestId('champion-overall-games')).not.toHaveTextContent('9,999');
    expect(seenRanks).toEqual([undefined, 'EMERALD_PLUS']);
  });

  it('writes a changed filter to the URL with replace and refetches', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (_k: string, _f: ChampionStatsFilters): Promise<ChampionBuildStats> => stats());
    renderPage('/champion/Jinx?role=BOTTOM', fetcher);
    await screen.findByRole('region', { name: 'Most popular' });
    const before = fetcher.mock.calls.length;

    // BOTTOM -> ALL (the default) clears the param and drops role from the fetch
    await user.selectOptions(screen.getByTestId('champion-filter-role'), 'ALL');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/champion/Jinx'));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
    expect(fetcher.mock.calls.at(-1)?.[1].role).toBeUndefined();
  });

  it('shows the not-enough-data notice and no panels below the display floor (Requirement 7.1)', async () => {
    renderPage('/champion/Jinx', async () =>
      stats({ meta: { ...stats().meta, overall: { winRate: 0, pickRate: 0, totalGames: 12 } }, popular: null, highestWinRate: null }),
    );
    expect(await screen.findByTestId('champion-not-enough-data')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Most popular' })).not.toBeInTheDocument();
    // the header + filters still render
    expect(screen.getByTestId('champion-stats-filters')).toBeInTheDocument();
  });

  it('shows the MIN_SAMPLE card instead of the second panel when highestWinRate is null (Requirement 7.2)', async () => {
    renderPage('/champion/Jinx', async () => stats({ highestWinRate: null }));
    await screen.findByRole('region', { name: 'Most popular' });
    expect(screen.getByTestId('champion-no-min-sample')).toHaveTextContent('500 games');
    expect(screen.queryByTestId('build-win-rate')).toBeInTheDocument(); // popular panel still there
  });

  it('has no crawl / refresh control anywhere (Requirement 8.3)', async () => {
    renderPage('/champion/Jinx', async () => stats());
    await screen.findByRole('region', { name: 'Most popular' });
    expect(screen.queryByRole('button', { name: /refresh|update|crawl/i })).not.toBeInTheDocument();
  });

  it('renders an inline error with a retry that refetches (Requirement 4.4)', async () => {
    let attempt = 0;
    const fetcher: ChampionBuildStatsFetcher = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('500');
      return stats();
    };
    const user = userEvent.setup();
    renderPage('/champion/Jinx', fetcher);
    const err = await screen.findByTestId('champion-build-error');
    await user.click(within(err).getByTestId('champion-build-retry'));
    await screen.findByRole('region', { name: 'Most popular' });
  });
});
