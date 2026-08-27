import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MatchParticipant, RecentMatchSummary } from '../api/types';
import { formatMatchDuration, matchQueueTypeLabel, MatchRow } from './MatchRow';

const RID = { gameName: 'Tester', tagLine: 'NA1' };

/**
 * `match-detail-tabs` task 5.2 — Requirements 1.2, 1.3, 1.6, 1.7.
 *
 * No Static_Data_Provider is seeded: every icon call site resolves to an
 * Asset_Placeholder, which is enough to verify MatchRow's OWN contract — which
 * participant it looked up, which side it rendered, and what it rendered when
 * there was nothing to look up — without re-testing icon resolution itself
 * (covered by `provider.test.ts` and `CdnImage.test.tsx`).
 */

function participant(overrides: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'Someone',
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
    turretKills: 0,
    dragonKills: 0,
    baronKills: 0,
    killParticipationPercent: 'N/A',
    augments: [],
    ...overrides,
  };
}

function match(overrides: Partial<RecentMatchSummary> = {}): RecentMatchSummary {
  return {
    matchId: 'NA1_1',
    championName: 'Vayne',
    role: 'BOTTOM',
    win: true,
    kills: 8,
    deaths: 2,
    assists: 6,
    cs: 210,
    csPerMinute: 7,
    visionScore: 24,
    startTimestamp: 1_700_000_000_000,
    durationSeconds: 1_927,
    opponent: null,
    build: { items: [1001, 3006, 0, 0, 0, 0], trinket: 3340 },
    participants: [],
    queueType: 'ranked solo/duo',
    ...overrides,
  };
}

describe('formatMatchDuration', () => {
  it('formats seconds as mm:ss, zero-padding seconds under 10', () => {
    expect(formatMatchDuration(1_927)).toBe('32:07');
    expect(formatMatchDuration(60)).toBe('1:00');
    expect(formatMatchDuration(5)).toBe('0:05');
  });

  it('never throws on a non-finite or negative duration', () => {
    expect(formatMatchDuration(Number.NaN)).toBe('0:00');
    expect(formatMatchDuration(-100)).toBe('0:00');
  });
});

describe('matchQueueTypeLabel', () => {
  it('labels the three known queue types and falls back to the raw value otherwise', () => {
    expect(matchQueueTypeLabel('ranked solo/duo')).toBe('Ranked Solo/Duo');
    expect(matchQueueTypeLabel('ranked flex')).toBe('Ranked Flex');
    expect(matchQueueTypeLabel('normal')).toBe('Normal');
    expect(matchQueueTypeLabel('aram')).toBe('aram');
  });
});

describe('MatchRow — Requirement 1.6: duration and queue type', () => {
  it('displays the match duration and queue type, which the row did not show before this feature', () => {
    render(<MatchRow riotId={RID} match={match({ durationSeconds: 1_927, queueType: 'ranked flex' })} />);

    expect(screen.getByTestId('recent-match-NA1_1-duration')).toHaveTextContent('32:07');
    expect(screen.getByTestId('recent-match-NA1_1-queue-type')).toHaveTextContent('Ranked Flex');
  });
});

describe('MatchRow — Requirement 1.7: no Enemy_Laner identified', () => {
  it('renders the no-opponent notice and no opposing side at all', () => {
    render(<MatchRow riotId={RID} match={match({ opponent: null })} />);

    expect(screen.getByTestId('recent-match-NA1_1-no-opponent')).toBeInTheDocument();
    expect(screen.queryByTestId('match-side-opponent')).not.toBeInTheDocument();
    // The analyzed player's own side still renders in full.
    expect(screen.getByTestId('match-side-player')).toBeInTheDocument();
  });
});

describe('MatchRow — mirrored sides read spells and runes from the marked participant', () => {
  it('renders both sides when an Enemy_Laner was identified, each reading its own participant record', () => {
    render(
      <MatchRow riotId={RID}
        match={match({
          opponent: {
            championName: 'Jinx',
            kills: 3,
            deaths: 7,
            assists: 1,
            cs: 175,
            csPerMinute: 5.83,
            visionScore: 11,
            build: { items: [0, 0, 0, 0, 0, 0], trinket: 3364 },
          },
          participants: [
            participant({ isAnalyzedPlayer: true, teamId: 100, championName: 'Vayne', summonerSpells: [4, 7] }),
            participant({ isEnemyLaner: true, teamId: 200, championName: 'Jinx', summonerSpells: [4, 12] }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('match-side-player')).toBeInTheDocument();
    expect(screen.getByTestId('match-side-opponent')).toBeInTheDocument();
    // Every icon on both sides resolves to a placeholder with no provider seeded —
    // four loadout icons per side (2 spells, keystone, secondary tree) plus the
    // champion portrait, so at least 5 placeholders exist per side.
    const placeholders = screen.getAllByTestId('asset-placeholder');
    expect(placeholders.length).toBeGreaterThanOrEqual(10);
  });

  it('still shows the row’s existing values — outcome, champion, K/D/A, CS/min, vision — unchanged', () => {
    render(<MatchRow riotId={RID} match={match()} />);
    const row = screen.getByTestId('recent-match-NA1_1');

    expect(row).toHaveTextContent('Victory');
    expect(row).toHaveTextContent('8/2/6');
    expect(row).toHaveTextContent('7.0(210)');
    expect(row).toHaveTextContent('24');
  });

  it('shows each side’s player name above their champion, reading from the marked participant', () => {
    render(
      <MatchRow riotId={RID}
        match={match({
          opponent: {
            championName: 'Jinx',
            kills: 3,
            deaths: 7,
            assists: 1,
            cs: 175,
            csPerMinute: 5.83,
            visionScore: 11,
            build: { items: [0, 0, 0, 0, 0, 0], trinket: 3364 },
          },
          participants: [
            participant({ isAnalyzedPlayer: true, teamId: 100, riotIdGameName: 'Doffy', riotIdTagline: 'Smile' }),
            participant({ isEnemyLaner: true, teamId: 200, riotIdGameName: 'RivalName', riotIdTagline: 'EUW' }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('match-side-player')).toHaveTextContent('Doffy');
    expect(screen.getByTestId('match-side-player')).toHaveTextContent('#Smile');
    expect(screen.getByTestId('match-side-opponent')).toHaveTextContent('RivalName');
    expect(screen.getByTestId('match-side-opponent')).toHaveTextContent('#EUW');
  });

  it('omits the name line rather than rendering a bare "#" when no marked participant supplied one', () => {
    render(<MatchRow riotId={RID} match={match({ participants: [] })} />);
    const playerSide = screen.getByTestId('match-side-player');
    expect(playerSide.textContent).not.toContain('#');
  });
});

describe('MatchRow — Detail_Panel expansion (Requirements 2.1, 2.2, 2.4, 2.5)', () => {
  it('renders every Detail_Panel collapsed on initial render', () => {
    render(<MatchRow riotId={RID} match={match()} />);
    expect(screen.queryByTestId('detail-panel-NA1_1')).not.toBeInTheDocument();
  });

  it('expands and collapses on the toggle control', () => {
    render(<MatchRow riotId={RID} match={match()} />);
    const toggle = screen.getByTestId('recent-match-NA1_1-expand-toggle');

    fireEvent.click(toggle);
    expect(screen.getByTestId('detail-panel-NA1_1')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('detail-panel-NA1_1')).not.toBeInTheDocument();
  });

  it('selects the General tab on first expansion and restores the last-selected tab on a later expansion of the same row', () => {
    render(<MatchRow riotId={RID} match={match()} />);
    const toggle = screen.getByTestId('recent-match-NA1_1-expand-toggle');

    fireEvent.click(toggle); // first expansion
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Runes' }));
    expect(screen.getByRole('tab', { name: 'Runes' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(toggle); // collapse
    expect(screen.queryByTestId('detail-panel-NA1_1')).not.toBeInTheDocument();

    fireEvent.click(toggle); // re-expand — Runes must still be selected, not reset to General
    expect(screen.getByRole('tab', { name: 'Runes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps two rows’ expansion and tab selection fully independent', () => {
    render(
      <ul>
        <MatchRow riotId={RID} match={match({ matchId: 'NA1_1' })} />
        <MatchRow riotId={RID} match={match({ matchId: 'NA1_2' })} />
      </ul>,
    );

    fireEvent.click(screen.getByTestId('recent-match-NA1_1-expand-toggle'));
    expect(screen.getByTestId('detail-panel-NA1_1')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-panel-NA1_2')).not.toBeInTheDocument();

    // Row 1 selects Runes; row 2 is expanded afterward and must still default to General.
    const row1Tabs = screen.getAllByRole('tab', { name: 'Runes' });
    fireEvent.click(row1Tabs[0]);

    fireEvent.click(screen.getByTestId('recent-match-NA1_2-expand-toggle'));
    expect(screen.getByTestId('detail-panel-NA1_2')).toBeInTheDocument();

    const generalTabs = screen.getAllByRole('tab', { name: 'General' });
    // Row 2's General tab is selected; row 1's is not (it moved to Runes).
    const row2GeneralTab = generalTabs.find((tab) => tab.id.includes('NA1_2'));
    expect(row2GeneralTab).toHaveAttribute('aria-selected', 'true');
    const row1GeneralTab = generalTabs.find((tab) => tab.id.includes('NA1_1'));
    expect(row1GeneralTab).toHaveAttribute('aria-selected', 'false');
  });

  it('issues no request when expanding or selecting General/Runes (Requirement 2.7)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<MatchRow riotId={RID} match={match()} />);
    fireEvent.click(screen.getByTestId('recent-match-NA1_1-expand-toggle'));
    fireEvent.click(screen.getByRole('tab', { name: 'Runes' }));
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('MatchRow — Laneless_Match suppresses role and opponent (Requirement 11.4, 11.5)', () => {
  it('shows no role text and no opposing side when role is blank and opponent is null', () => {
    render(<MatchRow riotId={RID} match={match({ role: '', opponent: null, queueType: 'aram' })} />);

    expect(screen.queryByText('BOTTOM')).not.toBeInTheDocument();
    expect(screen.getByTestId('recent-match-NA1_1-no-opponent')).toBeInTheDocument();
    expect(screen.queryByTestId('match-side-opponent')).not.toBeInTheDocument();
  });

  it('still shows every other field unchanged for a laneless match', () => {
    render(<MatchRow riotId={RID} match={match({ role: '', opponent: null, queueType: 'aram mayhem' })} />);
    const row = screen.getByTestId('recent-match-NA1_1');

    expect(row).toHaveTextContent('Victory');
    expect(row).toHaveTextContent('8/2/6');
    expect(row).toHaveTextContent('7.0(210)');
    expect(row).toHaveTextContent('24');
    expect(screen.getByTestId('recent-match-NA1_1-duration')).toHaveTextContent('32:07');
    expect(screen.getByTestId('recent-match-NA1_1-queue-type')).toHaveTextContent('aram mayhem');
  });
});
