import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChampionBuild } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { ChampionBuildPanel } from './ChampionBuildPanel';

const VERSION = '16.17.1';

function build(overrides: Partial<ChampionBuild> = {}): ChampionBuild {
  return {
    matchCount: 1240,
    winRate: 0.5123,
    pickRate: 0.337,
    coreItems: [3006, 3031, 3036],
    startingItems: [1055],
    skillOrder: { maxOrder: ['Q', 'W', 'E'], perLevel: [1, 3, 2, 1, 1] },
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

function renderPanel(b: ChampionBuild) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, { data: {} }));
  return render(
    <StaticDataContext.Provider value={provider}>
      <ChampionBuildPanel label="Most popular" championKey="Jinx" build={b} />
    </StaticDataContext.Provider>,
  );
}

describe('ChampionBuildPanel', () => {
  it('formats the headline figures (Requirement 5.3)', () => {
    renderPanel(build());
    const panel = screen.getByRole('region', { name: 'Most popular' });
    expect(within(panel).getByTestId('build-win-rate')).toHaveTextContent('51.2%');
    expect(within(panel).getByTestId('build-pick-rate')).toHaveTextContent('33.7%');
    // thousands separator + an unambiguous "this build" label
    expect(within(panel).getByTestId('build-match-count')).toHaveTextContent('1,240 games');
    expect(within(panel).getByText('Games on this build')).toBeInTheDocument();
  });

  it('renders every sub-section when the build is complete', () => {
    renderPanel(build());
    expect(screen.getByTestId('core-items')).toBeInTheDocument();
    expect(screen.getByTestId('skill-order')).toBeInTheDocument();
    expect(screen.getByTestId('champion-build-runes')).toBeInTheDocument();
    expect(screen.getByTestId('build-spells')).toBeInTheDocument();
  });

  it('shows a per-section "not enough data" line for each null field, panel still renders (Requirement 7.3)', () => {
    renderPanel(build({ skillOrder: null, runes: null, summonerSpells: null, coreItems: [] }));
    expect(screen.getByRole('region', { name: 'Most popular' })).toBeInTheDocument();
    expect(screen.queryByTestId('skill-order')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-spells')).not.toBeInTheDocument();
    expect(screen.getByTestId('champion-build-runes-unavailable')).toBeInTheDocument();
    // three "Not enough data yet." lines (core items, skill order, spells)
    expect(screen.getAllByText('Not enough data yet.')).toHaveLength(3);
  });

  it('never renders NaN / Infinity% on holey rate data (Requirement 5.5)', () => {
    renderPanel(build({ winRate: Number.NaN, pickRate: Number.POSITIVE_INFINITY }));
    expect(screen.getByTestId('build-win-rate')).toHaveTextContent('—');
    expect(screen.getByTestId('build-pick-rate')).toHaveTextContent('—');
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('renders the optional same-build note', () => {
    const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, { data: {} }));
    render(
      <StaticDataContext.Provider value={provider}>
        <ChampionBuildPanel label="Highest win rate" championKey="Jinx" build={build()} note="Also the most popular build." />
      </StaticDataContext.Provider>,
    );
    expect(screen.getByText('Also the most popular build.')).toBeInTheDocument();
  });
});
