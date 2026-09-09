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
    coreItems: [[3006], [3031], [3036]],
    startingItems: { value: [1055], games: 1100 },
    skillOrder: { value: { maxOrder: ['Q', 'W', 'E'], perLevel: [1, 3, 2, 1, 1] }, games: 900 },
    runes: {
      value: {
        primaryStyle: 8100,
        secondaryStyle: 8000,
        primarySelections: [8112, 8126, 8138, 8135],
        secondarySelections: [9111, 8014],
        statShards: [5008, 5008, 5001],
      },
      games: 1000,
    },
    summonerSpells: { value: [4, 7], games: 1200 },
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
    expect(screen.getByTestId('build-starting-items')).toBeInTheDocument();
  });

  it('shows the per-section game count next to each section (Requirement 8-style provenance)', () => {
    renderPanel(build());
    // runes 1,000 · skill order 900 · starting items 1,100 · spells 1,200
    const tags = screen.getAllByText(/^[\d,]+ games$/).map((n) => n.textContent);
    expect(tags).toEqual(expect.arrayContaining(['1,000 games', '900 games', '1,100 games', '1,200 games']));
  });

  it('orders the sections runes -> skill order -> core items, with spells alongside the items', () => {
    renderPanel(build());
    const runes = screen.getByTestId('champion-build-runes');
    const skills = screen.getByTestId('skill-order');
    const items = screen.getByTestId('core-items');
    const spells = screen.getByTestId('build-spells');
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(runes, skills)).toBe(true);
    expect(before(skills, items)).toBe(true);
    // items + spells share the one combined section
    expect(items.closest('.champion-build-combo')).toBe(spells.closest('.champion-build-combo'));
    expect(items.closest('.champion-build-combo')).not.toBeNull();
  });

  it('shows a per-section "not enough data" line for each null field, panel still renders (Requirement 7.3)', () => {
    renderPanel(
      build({ skillOrder: null, runes: null, summonerSpells: null, startingItems: null, coreItems: [] }),
    );
    expect(screen.getByRole('region', { name: 'Most popular' })).toBeInTheDocument();
    expect(screen.queryByTestId('skill-order')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-spells')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-starting-items')).not.toBeInTheDocument();
    expect(screen.getByTestId('champion-build-runes-unavailable')).toBeInTheDocument();
    // four "Not enough data yet." lines (starting items, core build, skill order, spells)
    expect(screen.getAllByText('Not enough data yet.')).toHaveLength(4);
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
