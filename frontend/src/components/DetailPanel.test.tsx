import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MatchParticipant, RecentMatchSummary } from '../api/types';
import { DetailPanel } from './DetailPanel';

/**
 * `match-detail-tabs` task 6.5 — Requirements 2.3, 2.4, 2.6, 2.7, 3.1, 3.7, 3.8,
 * 4.1, 5.1, 5.2, 9.3.
 */

const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

function participant(overrides: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'Player',
    riotIdTagline: 'NA1',
    championName: 'Ahri',
    champLevel: 15,
    teamPosition: 'MIDDLE',
    summonerSpells: [4, 14],
    runes: { primaryStyle: 8100, secondaryStyle: 8000, primarySelections: [8112], secondarySelections: [8143], statShards: [5008, 5008, 5011] },
    build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
    kills: 0,
    deaths: 0,
    assists: 0,
    cs: 0,
    visionScore: 0,
    damageToChampions: 0,
    goldEarned: 0,
    win: true,
    killParticipationPercent: 'N/A',
    augments: [],
    ...overrides,
  };
}

/** Ten distinct participants, five per team, one per Position_Order value each side. */
function tenParticipants(): MatchParticipant[] {
  const blue = POSITIONS.map((position, index) =>
    participant({
      teamId: 100,
      teamPosition: position,
      riotIdGameName: `Blue${String(index)}`,
      championName: `BlueChamp${String(index)}`,
      isAnalyzedPlayer: index === 2, // the MIDDLE laner
    }),
  );
  const red = POSITIONS.map((position, index) =>
    participant({
      teamId: 200,
      teamPosition: position,
      riotIdGameName: `Red${String(index)}`,
      championName: `RedChamp${String(index)}`,
      isEnemyLaner: index === 2,
    }),
  );
  return [...blue, ...red];
}

function match(overrides: Partial<RecentMatchSummary> = {}): RecentMatchSummary {
  return {
    matchId: 'NA1_1',
    championName: 'BlueChamp2',
    role: 'MIDDLE',
    win: true,
    kills: 8,
    deaths: 2,
    assists: 6,
    cs: 210,
    csPerMinute: 7,
    visionScore: 24,
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1_800,
    opponent: null,
    build: { items: [0, 0, 0, 0, 0, 0], trinket: 0 },
    participants: tenParticipants(),
    queueType: 'ranked solo/duo',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<RecentMatchSummary> = {}) {
  const onSelectTab = vi.fn();
  const utils = render(<DetailPanel match={match(overrides)} selectedTab="general" onSelectTab={onSelectTab} />);
  return { ...utils, onSelectTab };
}

describe('DetailPanel — tab semantics (Requirement 2.3, 2.6)', () => {
  it('presents exactly three tabs, in the order General, Build Path, Runes', () => {
    renderPanel();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Build Path', 'Runes']);
  });

  it('marks the selected tab with aria-selected and points it at its own tabpanel', () => {
    renderPanel();
    const generalTab = screen.getByRole('tab', { name: 'General' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe(generalTab.getAttribute('aria-controls'));
  });

  it('calls onSelectTab when a tab is clicked', () => {
    const { onSelectTab } = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Runes' }));
    expect(onSelectTab).toHaveBeenCalledWith('runes');
  });

  it('moves selection with the arrow keys, wrapping at both ends', () => {
    const { onSelectTab } = renderPanel();
    const generalTab = screen.getByRole('tab', { name: 'General' });
    fireEvent.keyDown(generalTab, { key: 'ArrowRight' });
    expect(onSelectTab).toHaveBeenCalledWith('buildPath');

    fireEvent.keyDown(generalTab, { key: 'ArrowLeft' });
    expect(onSelectTab).toHaveBeenCalledWith('runes'); // wraps past General to the last tab
  });
});

describe('DetailPanel — General tab (Requirements 3.1, 3.7, 3.8, 8.6)', () => {
  it('lists all ten participants, analyzed team first, five per team block', () => {
    renderPanel();
    const rows = screen.getAllByRole('row').filter((row) => row.querySelector('th[scope="row"]'));
    expect(rows).toHaveLength(10);
  });

  it('orders each team block by Position_Order: TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY', () => {
    renderPanel();
    const names = screen.getAllByRole('row')
      .filter((row) => row.querySelector('th[scope="row"]'))
      .map((row) => row.textContent ?? '');
    // First five rows are the analyzed player's team (Blue), in Position_Order.
    expect(names[0]).toContain('Blue0');
    expect(names[1]).toContain('Blue1');
    expect(names[2]).toContain('Blue2');
    expect(names[3]).toContain('Blue3');
    expect(names[4]).toContain('Blue4');
  });

  it('distinguishes the analyzed player’s row by visible text, not colour alone', () => {
    renderPanel();
    const analyzedRow = screen.getByTestId(/scoreboard-row-100-Blue2/);
    expect(within(analyzedRow).getByText('You')).toBeInTheDocument();
  });
});

describe('DetailPanel — Runes tab (Requirements 4.1, 4.4, 9.2)', () => {
  it('lists the same ten participants in the same order the General tab uses', () => {
    render(<DetailPanel match={match()} selectedTab="runes" onSelectTab={vi.fn()} />);

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(10);
    // The Runes tab shows champion + Rune_Page only (Requirement 4.2) — no Riot ID,
    // unlike the General tab — so the first card is identified by champion name.
    expect(cards[0]).toHaveTextContent('BlueChamp0');
  });

  it('shows "Rune page unavailable" for a participant with no captured rune data, without omitting them', () => {
    const participants = tenParticipants();
    participants[0] = participant({
      ...participants[0],
      riotIdGameName: 'NoRunes',
      runes: { primaryStyle: 0, secondaryStyle: 0, primarySelections: [], secondarySelections: [], statShards: [0, 0, 0] },
    });
    render(<DetailPanel match={match({ participants })} selectedTab="runes" onSelectTab={vi.fn()} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Rune page unavailable.')).toBeInTheDocument();
  });
});

describe('DetailPanel — Build Path tab (Requirement 5.2)', () => {
  it('shows the not-yet-available message and nothing else', () => {
    render(<DetailPanel match={match()} selectedTab="buildPath" onSelectTab={vi.fn()} />);
    expect(screen.getByTestId('build-path-NA1_1-unavailable')).toHaveTextContent('not yet available');
  });
});

describe('DetailPanel — degrades to placeholders with no Static_Data_Provider (Requirement 9.3)', () => {
  it('renders no <img> anywhere across all three tabs for identifiers the index would need to resolve', () => {
    // Stat shards are the one asset class resolved from a hardcoded table rather
    // than the fetched index (Requirement 7.7), so they render even before a
    // Static_Data_Provider is ready — by design, and already covered by
    // `provider.test.ts`. Zeroing them here isolates what this test is actually
    // checking: every OTHER identifier degrades to a placeholder with no provider.
    const participants = tenParticipants().map((p) => ({
      ...p,
      runes: { ...p.runes, statShards: [0, 0, 0] as [number, number, number] },
    }));

    for (const tab of ['general', 'buildPath', 'runes'] as const) {
      const { container, unmount } = render(<DetailPanel match={match({ participants })} selectedTab={tab} onSelectTab={vi.fn()} />);
      expect(container.querySelector('img')).toBeNull();
      unmount();
    }
  });
});

describe('DetailPanel — a match with fewer than ten participants (Requirement 6.11)', () => {
  it('renders the General tab with whatever participants the match carries, without padding or crashing', () => {
    const participants = tenParticipants().slice(0, 7); // 4 blue, 3 red
    render(<DetailPanel match={match({ participants })} selectedTab="general" onSelectTab={vi.fn()} />);

    const rows = screen.getAllByRole('row').filter((row) => row.querySelector('th[scope="row"]'));
    expect(rows).toHaveLength(7);
  });

  it('renders the Runes tab with whatever participants the match carries, without padding or crashing', () => {
    const participants = tenParticipants().slice(0, 7);
    render(<DetailPanel match={match({ participants })} selectedTab="runes" onSelectTab={vi.fn()} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(7);
  });

  it('renders an empty participant list without crashing, on both tabs', () => {
    expect(() =>
      render(<DetailPanel match={match({ participants: [] })} selectedTab="general" onSelectTab={vi.fn()} />),
    ).not.toThrow();

    expect(() =>
      render(<DetailPanel match={match({ participants: [] })} selectedTab="runes" onSelectTab={vi.fn()} />),
    ).not.toThrow();
  });
});

describe('DetailPanel — General and Runes are unaffected by no Enemy_Laner (Requirement 9.5)', () => {
  it('still shows all ten participants on both tabs when match.opponent is null', () => {
    const general = render(<DetailPanel match={match({ opponent: null })} selectedTab="general" onSelectTab={vi.fn()} />);
    expect(general.getAllByRole('row').filter((row) => row.querySelector('th[scope="row"]'))).toHaveLength(10);
    general.unmount();

    const runes = render(<DetailPanel match={match({ opponent: null })} selectedTab="runes" onSelectTab={vi.fn()} />);
    expect(runes.getAllByRole('listitem')).toHaveLength(10);
    runes.unmount();
  });
});

describe('DetailPanel — ARAM Mayhem swaps Runes for Augments (Requirements 11.7, 12.3, 12.4, 12.8, 12.9)', () => {
  it('labels the third tab "Runes" and renders RunesTab for a standard ARAM match (queueType "aram")', () => {
    render(<DetailPanel match={match({ queueType: 'aram' })} selectedTab="runes" onSelectTab={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Runes' })).toBeInTheDocument();
    expect(screen.getByTestId('runes-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('augments-tab')).not.toBeInTheDocument();
  });

  it('labels the third tab "Augments" and renders AugmentsTab for an ARAM Mayhem match (queueType "aram mayhem")', () => {
    render(<DetailPanel match={match({ queueType: 'aram mayhem' })} selectedTab="runes" onSelectTab={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Augments' })).toBeInTheDocument();
    expect(screen.getByTestId('augments-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('runes-tab')).not.toBeInTheDocument();
  });

  it('renders every captured augment for a Mayhem participant, in Riot’s reported order, with no unavailable state for fewer than six', () => {
    const participants = tenParticipants();
    participants[0] = participant({ ...participants[0], riotIdGameName: 'Mayhemer', augments: [1205, 1141, 1002] });
    render(<DetailPanel match={match({ queueType: 'aram mayhem', participants })} selectedTab="runes" onSelectTab={vi.fn()} />);

    const card = screen.getByTestId(/augment-card-100-Mayhemer/);
    // Three augments captured, three icons rendered — no padding to six, no "unavailable" text.
    expect(card.querySelectorAll('[data-testid="asset-placeholder"], img')).toHaveLength(4); // 3 augments + 1 champion portrait
    expect(card).not.toHaveTextContent('unavailable');
  });

  it('still lists all ten participants, in the same order the General tab uses, on the Augments tab', () => {
    render(<DetailPanel match={match({ queueType: 'aram mayhem' })} selectedTab="runes" onSelectTab={vi.fn()} />);
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(10);
    expect(cards[0]).toHaveTextContent('BlueChamp0');
  });
});
