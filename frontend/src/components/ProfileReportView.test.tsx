import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProfileReport, ProfileStats } from '../api/types';
import { perQueueReportFields } from '../test/reportExtras';
import { ProfileReportView, formatKda, formatWinRate, orderedQueueTypes, queueLabel } from './ProfileReportView';

/** Task 16.4. Pure rendering assertions; no network, no hooks. */

const baseStats: ProfileStats = {
  rankedByQueue: {
    RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 50, leaguePoints: 50 },
    RANKED_FLEX_SR: { tier: 'GOLD', division: 'II', winRatePercent: 41, leaguePoints: 12 },
  },
  overallAverageKda: 3.07,
  topChampions: [
    { championName: 'Vayne', gamesPlayed: 6, winRatePercent: 67, averageKda: 3.16, averageCs: 172.5, averageCsPerMinute: 5.75 },
    { championName: 'Caitlyn', gamesPlayed: 3, winRatePercent: 67, averageKda: 3.17, averageCs: 165.33, averageCsPerMinute: 5.51 },
  ],
  mostPlayedRole: 'BOTTOM',
  averageMatchDurationMinutes: 28.5,
};

function report(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    resolvedPlatform: 'na1',
    usedPlatformOverride: false,
    stats: baseStats,
    ...perQueueReportFields(baseStats),
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

describe('Requirements 6.1, 6.2, 6.6 — ranked standing', () => {
  it('shows a single standing — the queue the filter selects — with tier, division, LP and win rate', () => {
    render(<ProfileReportView report={report()} />);

    // Default filter is solo, so only the solo standing renders.
    const solo = screen.getByTestId('queue-RANKED_SOLO_5x5');
    expect(solo).toHaveTextContent('PLATINUM IV');
    expect(solo).toHaveTextContent('50 LP');
    expect(solo).toHaveTextContent('50% WR');
    expect(screen.queryByTestId('queue-RANKED_FLEX_SR')).not.toBeInTheDocument();
  });

  it('shows the flex standing when the Flex tab is selected', () => {
    render(<ProfileReportView report={report()} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-flex'));

    expect(screen.getByTestId('queue-RANKED_FLEX_SR')).toHaveTextContent('GOLD II');
    expect(screen.queryByTestId('queue-RANKED_SOLO_5x5')).not.toBeInTheDocument();
  });

  it('renders "N/A" rather than a computed value when wins + losses is 0 (Requirement 6.6)', () => {
    render(
      <ProfileReportView
        report={report({
          stats: {
            ...report().stats,
            rankedByQueue: { RANKED_SOLO_5x5: { tier: 'IRON', division: 'IV', winRatePercent: 'N/A' , leaguePoints: 0 } },
          },
        })}
      />,
    );

    expect(screen.getByTestId('queue-RANKED_SOLO_5x5')).toHaveTextContent('N/A WR');
  });

  it('renders "Unranked" for a queue with no entry (Requirement 6.1)', () => {
    render(
      <ProfileReportView
        report={report({
          stats: { ...report().stats, rankedByQueue: { RANKED_SOLO_5x5: 'Unranked' } },
        })}
      />,
    );

    expect(screen.getByTestId('queue-RANKED_SOLO_5x5')).toHaveTextContent('Unranked');
  });

  it('says so when there are no ranked entries at all', () => {
    render(<ProfileReportView report={report({ stats: { ...report().stats, rankedByQueue: {} } })} />);

    expect(screen.getByTestId('no-ranked-entries')).toBeInTheDocument();
  });

  it('renders an unrecognized queue type Riot returns, rather than dropping it', () => {
    // A live lookup really did return RANKED_PREMADE_5x5.
    render(
      <ProfileReportView
        report={report({
          stats: {
            ...report().stats,
            rankedByQueue: { RANKED_PREMADE_5x5: { tier: 'SILVER', division: 'II', winRatePercent: 33 , leaguePoints: 88 } },
          },
        })}
      />,
    );

    expect(screen.getByTestId('queue-RANKED_PREMADE_5x5')).toHaveTextContent('SILVER II');
  });

  it('orders queues stably regardless of the response key order', () => {
    expect(orderedQueueTypes({ RANKED_FLEX_SR: 'Unranked', RANKED_SOLO_5x5: 'Unranked' })).toEqual([
      'RANKED_SOLO_5x5',
      'RANKED_FLEX_SR',
    ]);
    // Unknown queues follow the known ones, alphabetically.
    expect(
      orderedQueueTypes({ ZZZ: 'Unranked', RANKED_PREMADE_5x5: 'Unranked', RANKED_SOLO_5x5: 'Unranked' }),
    ).toEqual(['RANKED_SOLO_5x5', 'RANKED_PREMADE_5x5', 'ZZZ']);
  });

  it('falls back to the raw queue type when there is no label for it', () => {
    expect(queueLabel('RANKED_SOLO_5x5')).toBe('Ranked Solo/Duo');
    expect(queueLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('Requirements 6.3, 6.5, 7.3 — recent form (scoped to the sidebar filter)', () => {
  /**
   * Overrides the `ranked solo/duo` slice, then selects that tab (the
   * sidebar's default is `'all'` — these tests are about "the selected
   * slice", so they select the slice they set up).
   */
  function withSoloSlice(over: Partial<ProfileStats>): ProfileReport {
    const base = report();
    return report({
      statsByQueue: {
        ...base.statsByQueue,
        'ranked solo/duo': { ...base.statsByQueue['ranked solo/duo'], ...over },
      },
    });
  }

  it('shows the average KDA to 2 decimal places', () => {
    render(<ProfileReportView report={withSoloSlice({ overallAverageKda: 3.07 })} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-solo-duo'));
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('3.07');
  });

  it('pads a whole-number KDA to 2 decimals without changing the value', () => {
    render(<ProfileReportView report={withSoloSlice({ overallAverageKda: 3 })} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-solo-duo'));
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('3.00');
    expect(formatKda(3)).toBe('3.00');
    expect(formatKda(3.07)).toBe('3.07');
  });

  it('shows the most-played role for the selected slice (Requirement 6.5)', () => {
    render(<ProfileReportView report={withSoloSlice({ mostPlayedRole: 'JUNGLE' })} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-solo-duo'));
    expect(screen.getByTestId('most-played-role')).toHaveTextContent('JUNGLE');
  });

  it('shows the average match length for the selected slice, in minutes (Requirement 7.3)', () => {
    render(<ProfileReportView report={withSoloSlice({ averageMatchDurationMinutes: 31.2 })} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-solo-duo'));
    expect(screen.getByTestId('average-duration')).toHaveTextContent('31m');
  });

  it('re-scopes the three figures when the filter tab changes', () => {
    const base = report();
    render(
      <ProfileReportView
        report={report({
          statsByQueue: {
            ...base.statsByQueue,
            'ranked solo/duo': { ...base.statsByQueue['ranked solo/duo'], overallAverageKda: 1.1, mostPlayedRole: 'TOP', averageMatchDurationMinutes: 20 },
            normal: { ...base.statsByQueue.normal, overallAverageKda: 9.9, mostPlayedRole: 'SUPPORT', averageMatchDurationMinutes: 40, topChampions: base.statsByQueue.all.topChampions },
          },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-ranked-solo-duo'));
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('1.10');
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-normal'));
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('9.90');
    expect(screen.getByTestId('most-played-role')).toHaveTextContent('SUPPORT');
    expect(screen.getByTestId('average-duration')).toHaveTextContent('40m');
  });
});

describe('profile-sidebar Requirement 9 — sidebar gamemode filter', () => {
  function multiQueueReport(): ProfileReport {
    const base = report();
    const withChamp = (name: string): ProfileStats => ({
      ...baseStats,
      topChampions: [{ championName: name, gamesPlayed: 3, winRatePercent: 50, averageKda: 2, averageCs: 100, averageCsPerMinute: 5 }],
    });
    return report({
      statsByQueue: {
        all: withChamp('AllChamp'),
        'ranked solo/duo': withChamp('SoloChamp'),
        'ranked flex': { ...base.statsByQueue['ranked flex'], topChampions: [] },
        normal: withChamp('NormalChamp'),
      },
      rolePerformanceByQueue: {
        all: [{ role: 'MIDDLE', gamesPlayed: 3, winRatePercent: 50 }],
        'ranked solo/duo': [{ role: 'TOP', gamesPlayed: 3, winRatePercent: 100 }],
        'ranked flex': [],
        normal: [{ role: 'JUNGLE', gamesPlayed: 3, winRatePercent: 0 }],
      },
    });
  }

  it('defaults to All queues and shows that slice', () => {
    render(<ProfileReportView report={multiQueueReport()} />);
    expect(screen.getByTestId('sidebar-queue-filter-all')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('champion-AllChamp')).toBeInTheDocument();
    expect(screen.getByTestId('role-perf-MIDDLE')).toBeInTheDocument();
  });

  it('re-scopes champion preferences and role performance when changed, with no effect on recent matches', () => {
    render(<ProfileReportView report={multiQueueReport()} />);
    fireEvent.click(screen.getByTestId('sidebar-queue-filter-normal'));

    expect(screen.getByTestId('champion-NormalChamp')).toBeInTheDocument();
    expect(screen.queryByTestId('champion-SoloChamp')).not.toBeInTheDocument();
    expect(screen.getByTestId('role-perf-JUNGLE')).toBeInTheDocument();
    // The recent-matches filter is independent and untouched.
    expect(screen.getByTestId('recent-matches-queue-filter')).toHaveValue('all');
  });

  it('only offers queue values present in the report (plus the solo default)', () => {
    // `multiQueueReport` has no flex matches, so flex is not offered.
    render(<ProfileReportView report={multiQueueReport()} />);
    const tabs = screen
      .getByTestId('sidebar-queue-filter')
      .querySelectorAll('[role="tab"]');
    expect(Array.from(tabs).map((t) => t.textContent)).toEqual(['All', 'Solo', 'Normal']);
  });
});

describe('profile-sidebar Requirement 7 — champion preferences panel', () => {
  it('lists each champion with games, win rate and KDA', () => {
    render(<ProfileReportView report={report()} />);

    const vayne = screen.getByTestId('champion-Vayne');
    expect(vayne).toHaveTextContent('Vayne');
    expect(vayne).toHaveTextContent('6'); // games
    expect(vayne).toHaveTextContent('67%'); // win rate
    expect(vayne).toHaveTextContent('3.16'); // KDA
  });

  it('does not reorder what the backend ranked', () => {
    // Requirement 7.3's total order is computed and property-tested server-side.
    render(<ProfileReportView report={report()} />);

    const names = screen
      .getAllByTestId(/^champion-(Vayne|Caitlyn)$/)
      .map((el) => el.textContent ?? '');
    expect(names[0]).toContain('Vayne');
    expect(names[1]).toContain('Caitlyn');
  });

  it('says so when the selected queue slice has no champions', () => {
    const base = report();
    const empty = { ...base.statsByQueue.all, topChampions: [] };
    render(<ProfileReportView report={report({ statsByQueue: { ...base.statsByQueue, all: empty } })} />);
    expect(screen.getByTestId('no-champions')).toBeInTheDocument();
  });

  it('shows CS per minute to one decimal place', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('champion-Vayne-avg-cs')).toHaveTextContent('5.8');
  });
});

describe('Champion mastery panel — sits under Champion Preferences, above Role Performance', () => {
  it('renders the championMastery entries the report carries', () => {
    render(
      <ProfileReportView
        report={report({
          championMastery: [
            { championId: 103, championLevel: 7, championPoints: 250_000, gamesPlayed: 4, winRatePercent: 75, averageKda: 4.2 },
          ],
        })}
      />,
    );
    const row = screen.getByTestId('champion-mastery-103');
    expect(row).toHaveTextContent('75%');
    expect(row).toHaveTextContent('4');
  });

  it('shows the empty-state note when there is no mastery data', () => {
    render(<ProfileReportView report={report({ championMastery: [] })} />);
    expect(screen.getByTestId('no-champion-mastery')).toBeInTheDocument();
  });

  it('is positioned between the champion-preferences and role-performance headings', () => {
    render(
      <ProfileReportView
        report={report({
          championMastery: [
            { championId: 103, championLevel: 7, championPoints: 250_000, gamesPlayed: 4, winRatePercent: 75, averageKda: 4.2 },
          ],
        })}
      />,
    );
    const headingIds = screen.getAllByRole('heading', { level: 3 }).map((el) => el.id);
    const championsIndex = headingIds.indexOf('champions-heading');
    const masteryIndex = headingIds.indexOf('champion-mastery-heading');
    const roleIndex = headingIds.indexOf('role-perf-heading');
    expect(championsIndex).toBeGreaterThanOrEqual(0);
    expect(masteryIndex).toBeGreaterThan(championsIndex);
    expect(roleIndex).toBeGreaterThan(masteryIndex);
  });
});

describe('Recent matches — champion, outcome, K/D/A, CS, vision, and the lane opponent', () => {
  function reportWithMatch(opponent: ProfileReport['recentMatches'][number]['opponent']) {
    return report({
      recentMatches: [
        {
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
          durationSeconds: 1800,
          opponent,
          build: { items: [1001, 3006, 0, 0, 0, 0], trinket: 3340 },
          participants: [],
          queueType: 'ranked solo/duo',
          lpDelta: null,
        },
      ],
    });
  }

  it('shows the player’s own line stats for the match', () => {
    render(<ProfileReportView report={reportWithMatch(null)} />);
    const card = screen.getByTestId('recent-match-NA1_1');

    expect(card).toHaveTextContent('Victory');
    expect(card).toHaveTextContent('Vayne');
    expect(card).toHaveTextContent('8/2/6');
    expect(card).toHaveTextContent('7.0(210)');
    expect(card).toHaveTextContent('24');
  });

  it('shows the opposing laner’s stats when one was identified', () => {
    render(
      <ProfileReportView
        report={reportWithMatch({
          championName: 'Jinx',
          kills: 3,
          deaths: 7,
          assists: 1,
          cs: 175,
          csPerMinute: 5.83,
          visionScore: 11,
          build: { items: [0, 0, 0, 0, 0, 0], trinket: 3364 },
        })}
      />,
    );
    const card = screen.getByTestId('recent-match-NA1_1');

    expect(card).toHaveTextContent('Jinx');
    expect(card).toHaveTextContent('3/7/1');
    expect(card).toHaveTextContent('5.8(175)');
  });

  it('says so when no lane opponent could be identified', () => {
    render(<ProfileReportView report={reportWithMatch(null)} />);
    expect(screen.getByTestId('recent-match-NA1_1-no-opponent')).toBeInTheDocument();
  });

  it('says so when there are no recent matches', () => {
    render(<ProfileReportView report={report({ recentMatches: [] })} />);
    expect(screen.getByTestId('no-recent-matches')).toBeInTheDocument();
  });
});

describe('Recent matches — queue-type filter', () => {
  function match(matchId: string, queueType: string): ProfileReport['recentMatches'][number] {
    return {
      matchId,
      championName: 'Vayne',
      role: 'BOTTOM',
      win: true,
      kills: 1,
      deaths: 1,
      assists: 1,
      cs: 100,
      csPerMinute: 5,
      visionScore: 10,
      startTimestamp: 1_700_000_000_000,
      durationSeconds: 1800,
      opponent: null,
      build: { items: [0, 0, 0, 0, 0, 0], trinket: 3340 },
      participants: [],
      queueType,
      lpDelta: null,
    };
  }

  const mixed = report({
    recentMatches: [match('NA1_1', 'ranked solo/duo'), match('NA1_2', 'aram'), match('NA1_3', 'normal')],
  });

  it('defaults to all queues and shows every match', () => {
    render(<ProfileReportView report={mixed} />);
    expect((screen.getByTestId('recent-matches-queue-filter') as HTMLSelectElement).value).toBe('all');
    expect(screen.getByTestId('recent-match-NA1_1')).toBeInTheDocument();
    expect(screen.getByTestId('recent-match-NA1_2')).toBeInTheDocument();
    expect(screen.getByTestId('recent-match-NA1_3')).toBeInTheDocument();
  });

  it('narrows the list to the selected queue type', () => {
    render(<ProfileReportView report={mixed} />);
    fireEvent.change(screen.getByTestId('recent-matches-queue-filter'), { target: { value: 'aram' } });
    expect(screen.getByTestId('recent-match-NA1_2')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-match-NA1_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recent-match-NA1_3')).not.toBeInTheDocument();
  });

  it('shows a queue-specific empty note when no match matches the filter', () => {
    render(<ProfileReportView report={mixed} />);
    fireEvent.change(screen.getByTestId('recent-matches-queue-filter'), { target: { value: 'ranked-flex' } });
    expect(screen.getByTestId('no-recent-matches-for-queue')).toBeInTheDocument();
  });
});

describe('Recent matches / Live game / Clash tabs', () => {
  it('defaults to the Recent matches tab', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('main-tab-recent')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('main-tab-live')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('main-tab-clash')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('recent-matches-queue-filter')).toBeInTheDocument();
  });

  it('switches to the Live game panel when the Live game tab is clicked', () => {
    render(<ProfileReportView report={report()} />);
    fireEvent.click(screen.getByTestId('main-tab-live'));
    expect(screen.getByTestId('main-tab-live')).toHaveAttribute('aria-selected', 'true');
    // the recent-matches queue filter is replaced by the live panel
    expect(screen.queryByTestId('recent-matches-queue-filter')).not.toBeInTheDocument();
    expect(screen.getByText(/checking for a live game/i)).toBeInTheDocument();
  });

  it('switches to the Clash scouting panel when the Clash tab is clicked', () => {
    render(<ProfileReportView report={report()} />);
    fireEvent.click(screen.getByTestId('main-tab-clash'));
    expect(screen.getByTestId('main-tab-clash')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('recent-matches-queue-filter')).not.toBeInTheDocument();
    expect(screen.getByText(/checking for an active clash registration/i)).toBeInTheDocument();
  });
});

describe('Recent matches — load more', () => {
  function match(matchId: string, queueType: string): ProfileReport['recentMatches'][number] {
    return {
      matchId,
      championName: 'Vayne',
      role: 'BOTTOM',
      win: true,
      kills: 1,
      deaths: 1,
      assists: 1,
      cs: 100,
      csPerMinute: 5,
      visionScore: 10,
      startTimestamp: 1_700_000_000_000,
      durationSeconds: 1800,
      opponent: null,
      build: { items: [0, 0, 0, 0, 0, 0], trinket: 3340 },
      participants: [],
      queueType,
      lpDelta: null,
    };
  }

  const many = report({
    recentMatches: Array.from({ length: 23 }, (_, i) =>
      match(`NA1_${String(i)}`, i % 4 === 0 ? 'aram' : 'ranked solo/duo'),
    ),
  });

  it('shows one page of matches with a Load more button when more are available', () => {
    render(<ProfileReportView report={many} />);
    expect(screen.getByTestId('recent-match-NA1_9')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-match-NA1_10')).not.toBeInTheDocument();
    expect(screen.getByTestId('recent-matches-load-more')).toBeInTheDocument();
  });

  it('reveals another page each click, then hides the button at the end', () => {
    render(<ProfileReportView report={many} />);
    fireEvent.click(screen.getByTestId('recent-matches-load-more'));
    expect(screen.getByTestId('recent-match-NA1_19')).toBeInTheDocument();
    expect(screen.getByTestId('recent-matches-load-more')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('recent-matches-load-more'));
    expect(screen.getByTestId('recent-match-NA1_22')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-matches-load-more')).not.toBeInTheDocument();
  });

  it('resets to one page when the queue filter changes', () => {
    render(<ProfileReportView report={many} />);
    fireEvent.click(screen.getByTestId('recent-matches-load-more'));
    fireEvent.change(screen.getByTestId('recent-matches-queue-filter'), { target: { value: 'aram' } });
    // 6 aram matches (indexes 0,4,8,12,16,20) — one page shows all, no button.
    expect(screen.queryByTestId('recent-matches-load-more')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('recent-matches-queue-filter'), { target: { value: 'all' } });
    expect(screen.getByTestId('recent-match-NA1_9')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-match-NA1_10')).not.toBeInTheDocument();
  });
});

describe('Requirements 3.4, 7.5 — limited data notice', () => {
  it('shows the limited-data notice when the backend sets it', () => {
    render(<ProfileReportView report={report({ limitedDataNotice: true })} />);

    expect(screen.getByTestId('limited-data-notice')).toHaveTextContent(/limited data/i);
    expect(screen.getByTestId('limited-data-notice')).toHaveTextContent(/more match history/i);
  });

  it('omits the notice when it is not set', () => {
    render(<ProfileReportView report={report({ limitedDataNotice: false })} />);
    expect(screen.queryByTestId('limited-data-notice')).not.toBeInTheDocument();
  });
});

describe('player-insights — Fun Facts v2 / Performance Feedback sections', () => {
  function rankedMatch(matchId: string): ProfileReport['recentMatches'][number] {
    return {
      matchId,
      championName: 'Ahri',
      role: 'MIDDLE',
      win: true,
      kills: 1,
      deaths: 1,
      assists: 1,
      cs: 100,
      csPerMinute: 5,
      visionScore: 10,
      startTimestamp: 1_700_000_000_000,
      durationSeconds: 1_800,
      opponent: null,
      build: { items: [0, 0, 0, 0, 0, 0], trinket: 3340 },
      participants: [],
      queueType: 'ranked solo/duo',
      lpDelta: null,
    };
  }

  it('renders the Fun Facts and Performance Feedback backend-computed contents', () => {
    render(
      <ProfileReportView
        report={report({
          funFacts: [{ category: 'longestGame', text: 'Longest game: 45m 00s on Ahri, a win.' }],
          performanceFeedback: [
            { category: 'killParticipation', text: 'Low KP.', metricName: 'averageKillParticipationPercent', metricValue: 30, benchmarkValue: 50 },
          ],
          recentMatches: [rankedMatch('NA1_1')],
        })}
      />,
    );
    expect(screen.getByTestId('fun-fact-longestGame')).toHaveTextContent('Longest game: 45m 00s on Ahri');
    expect(screen.getByTestId('performance-feedback-killParticipation')).toHaveTextContent('Low KP.');
  });

  it('shows the ranked-games-needed notice when there are no ranked matches in recentMatches', () => {
    render(<ProfileReportView report={report({ performanceFeedback: [], recentMatches: [] })} />);
    expect(screen.getByTestId('no-ranked-games-for-feedback')).toBeInTheDocument();
  });

  it('shows "nothing stood out" instead when ranked matches exist but nothing triggered', () => {
    render(<ProfileReportView report={report({ performanceFeedback: [], recentMatches: [rankedMatch('NA1_1')] })} />);
    expect(screen.getByTestId('no-performance-feedback')).toBeInTheDocument();
    expect(screen.queryByTestId('no-ranked-games-for-feedback')).toBeNull();
  });
});

describe('Requirements 11.3, 11.4, 11.5 — freshness', () => {
  it('indicates a first retrieval when there is no timestamp (Requirement 11.5)', () => {
    render(<ProfileReportView report={report({ lastUpdated: null })} />);

    expect(screen.getByTestId('first-retrieval-notice')).toHaveTextContent(/first time/i);
    expect(screen.queryByTestId('last-updated')).not.toBeInTheDocument();
  });

  it('shows the last-updated timestamp when there is one (Requirement 11.4)', () => {
    const iso = '2026-08-18T10:24:58.650Z';
    render(<ProfileReportView report={report({ lastUpdated: iso })} />);

    const element = screen.getByTestId('last-updated');
    expect(element).toBeInTheDocument();
    // The machine-readable value is preserved exactly, whatever the display locale.
    expect(element.querySelector('time')).toHaveAttribute('dateTime', iso);
    expect(screen.queryByTestId('first-retrieval-notice')).not.toBeInTheDocument();
  });

  it('falls back to the raw value if the timestamp cannot be parsed', () => {
    render(<ProfileReportView report={report({ lastUpdated: 'not-a-date' })} />);
    expect(screen.getByTestId('last-updated')).toHaveTextContent('not-a-date');
  });

  it('warns that data may be outdated when the report came from cache (Requirement 11.3)', () => {
    render(<ProfileReportView report={report({ partialDataWarning: true })} />);

    expect(screen.getByTestId('partial-data-warning')).toHaveTextContent(/outdated or unavailable/i);
  });

  it('shows no staleness warning on a clean report', () => {
    render(<ProfileReportView report={report({ partialDataWarning: false })} />);
    expect(screen.queryByTestId('partial-data-warning')).not.toBeInTheDocument();
  });
});

describe('formatting helpers', () => {
  it('formats win rates, including the N/A case', () => {
    expect(formatWinRate(50)).toBe('50%');
    expect(formatWinRate(0)).toBe('0%');
    expect(formatWinRate('N/A')).toBe('N/A');
  });

  it('does not crash on a non-finite KDA', () => {
    expect(formatKda(Number.NaN)).toBe('0.00');
    expect(formatKda(Number.POSITIVE_INFINITY)).toBe('0.00');
  });
});

describe('report identity', () => {
  it('shows the Riot ID and summoner level', () => {
    render(<ProfileReportView report={report()} />);

    expect(screen.getByTestId('report-riot-id')).toHaveTextContent('Doffy#Smile');
    expect(screen.getByTestId('summoner-level')).toHaveTextContent('496');
  });

  it('does not render the PUUID, which is data-subject-identifying', () => {
    const { container } = render(<ProfileReportView report={report({ puuid: 'secret-puuid-value' })} />);

    expect(container.innerHTML).not.toContain('secret-puuid-value');
  });
});

describe('Requirement 5.2/5.3 — degraded rendering with no Static Data Provider', () => {
  it('renders the full report as placeholders, with no <img> whose source could not be constructed', () => {
    const { container } = render(
      <ProfileReportView
        report={report({
          recentMatches: [
            {
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
              durationSeconds: 1800,
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
              build: { items: [1001, 3006, 0, 0, 0, 0], trinket: 3340 },
              participants: [],
              queueType: 'ranked solo/duo',
              lpDelta: null,
            },
          ],
        })}
      />,
    );

    // The Static_Data_Provider is not seeded here, so `useStaticData()` falls back
    // to the not-ready context default — every icon and item slot must resolve to
    // an Asset_Placeholder, never a live <img> pointed at an unconstructed URL.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[data-testid="asset-placeholder"]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('report-riot-id')).toBeInTheDocument();
    expect(screen.getByTestId('recent-match-NA1_1')).toBeInTheDocument();
  });
});
