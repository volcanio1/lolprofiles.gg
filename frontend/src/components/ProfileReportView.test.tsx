import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProfileReport } from '../api/types';
import { ProfileReportView, formatKda, formatWinRate, orderedQueueTypes, queueLabel } from './ProfileReportView';

/** Task 16.4. Pure rendering assertions; no network, no hooks. */

function report(overrides: Partial<ProfileReport> = {}): ProfileReport {
  return {
    riotId: { gameName: 'Doffy', tagLine: 'Smile' },
    puuid: 'p-1',
    summonerLevel: 496,
    profileIconId: 7,
    stats: {
      rankedByQueue: {
        RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', winRatePercent: 50 },
        RANKED_FLEX_SR: { tier: 'GOLD', division: 'II', winRatePercent: 41 },
      },
      overallAverageKda: 3.07,
      topChampions: [
        { championName: 'Vayne', gamesPlayed: 6, winRatePercent: 67, averageKda: 3.16, averageCs: 172.5, averageCsPerMinute: 5.75 },
        { championName: 'Caitlyn', gamesPlayed: 3, winRatePercent: 67, averageKda: 3.17, averageCs: 165.33, averageCsPerMinute: 5.51 },
      ],
      mostPlayedRole: 'BOTTOM',
    },
    funFacts: [
      { category: 'rolePreference', text: 'Favourite role: BOTTOM, played in 19 of 28 recent matches (68%).' },
      { category: 'streak', text: 'Longest win streak in this window: 8; longest loss streak: 5.' },
    ],
    limitedDataNotice: false,
    recommendations: [
      {
        category: 'visionControl',
        text: 'Improve vision control.',
        metricName: 'averageVisionScorePerMatch',
        metricValue: 12.5,
      },
    ],
    averageMatchDurationMinutes: 30.38,
    recentMatches: [],
    lastUpdated: null,
    partialDataWarning: false,
    ...overrides,
  };
}

describe('Requirements 6.1, 6.2, 6.6 — ranked standing', () => {
  it('shows tier, division and win rate per queue', () => {
    render(<ProfileReportView report={report()} />);

    expect(screen.getByTestId('queue-RANKED_SOLO_5x5')).toHaveTextContent('PLATINUM IV');
    expect(screen.getByTestId('queue-RANKED_SOLO_5x5')).toHaveTextContent('50% win rate');
    expect(screen.getByTestId('queue-RANKED_FLEX_SR')).toHaveTextContent('GOLD II');
  });

  it('renders "N/A" rather than a computed value when wins + losses is 0 (Requirement 6.6)', () => {
    render(
      <ProfileReportView
        report={report({
          stats: {
            ...report().stats,
            rankedByQueue: { RANKED_SOLO_5x5: { tier: 'IRON', division: 'IV', winRatePercent: 'N/A' } },
          },
        })}
      />,
    );

    expect(screen.getByTestId('queue-RANKED_SOLO_5x5')).toHaveTextContent('N/A win rate');
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
            rankedByQueue: { RANKED_PREMADE_5x5: { tier: 'SILVER', division: 'II', winRatePercent: 33 } },
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

describe('Requirements 6.3, 6.5, 7.3 — recent form', () => {
  it('shows the average KDA to 2 decimal places', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('3.07');
  });

  it('pads a whole-number KDA to 2 decimals without changing the value', () => {
    render(<ProfileReportView report={report({ stats: { ...report().stats, overallAverageKda: 3 } })} />);
    expect(screen.getByTestId('overall-kda')).toHaveTextContent('3.00');
    expect(formatKda(3)).toBe('3.00');
    expect(formatKda(3.07)).toBe('3.07');
  });

  it('shows the most-played role (Requirement 6.5)', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('most-played-role')).toHaveTextContent('BOTTOM');
  });

  it('shows the average match duration in minutes (Requirement 7.3)', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('average-duration')).toHaveTextContent('30.38 minutes');
  });
});

describe('Requirement 6.4 — top champions', () => {
  it('lists each champion with games, win rate and KDA, in the order supplied', () => {
    render(<ProfileReportView report={report()} />);

    const rows = screen.getAllByRole('row').slice(1); // skip the header row
    expect(rows[0]).toHaveTextContent('Vayne');
    expect(rows[0]).toHaveTextContent('6');
    expect(rows[0]).toHaveTextContent('67%');
    expect(rows[0]).toHaveTextContent('3.16');
    expect(rows[1]).toHaveTextContent('Caitlyn');
  });

  it('does not reorder what the backend ranked', () => {
    // Requirement 6.4's total order is computed and property-tested server-side.
    render(<ProfileReportView report={report()} />);

    const names = screen.getAllByRole('row').slice(1).map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Vayne');
    expect(names[1]).toContain('Caitlyn');
  });

  it('says so when there are no champions to rank', () => {
    render(<ProfileReportView report={report({ stats: { ...report().stats, topChampions: [] } })} />);
    expect(screen.getByTestId('no-champions')).toBeInTheDocument();
  });

  it('shows average CS/min with the raw average CS in brackets', () => {
    render(<ProfileReportView report={report()} />);
    expect(screen.getByTestId('champion-Vayne-avg-cs')).toHaveTextContent('5.8(172.50)');
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

describe('Requirements 7.1, 7.2, 7.4, 7.5 — fun facts and limited data', () => {
  it('renders each fun fact with its category', () => {
    render(<ProfileReportView report={report()} />);

    expect(screen.getByTestId('fun-fact-rolePreference')).toHaveTextContent('Favourite role: BOTTOM');
    expect(screen.getByTestId('fun-fact-streak')).toHaveTextContent('Longest win streak');
  });

  it('shows the limited-data notice when the backend sets it (Requirements 3.4, 7.5)', () => {
    render(<ProfileReportView report={report({ limitedDataNotice: true })} />);

    expect(screen.getByTestId('limited-data-notice')).toHaveTextContent(/limited data/i);
    expect(screen.getByTestId('limited-data-notice')).toHaveTextContent(/more match history/i);
  });

  it('omits the notice when it is not set', () => {
    render(<ProfileReportView report={report({ limitedDataNotice: false })} />);
    expect(screen.queryByTestId('limited-data-notice')).not.toBeInTheDocument();
  });

  it('says so when no fun facts were derived', () => {
    render(<ProfileReportView report={report({ funFacts: [] })} />);
    expect(screen.getByTestId('no-fun-facts')).toBeInTheDocument();
  });
});

describe('Requirement 8.5 — recommendations carry their metric', () => {
  it('renders the text, the metric name and the computed value', () => {
    render(<ProfileReportView report={report()} />);

    const item = screen.getByTestId('recommendation-visionControl');
    expect(item).toHaveTextContent('Improve vision control.');
    expect(screen.getByTestId('metric-visionControl')).toHaveTextContent('averageVisionScorePerMatch');
    expect(screen.getByTestId('metric-visionControl')).toHaveTextContent('12.5');
  });

  it('states explicitly that none were triggered, since zero is a valid outcome', () => {
    render(<ProfileReportView report={report({ recommendations: [] })} />);

    expect(screen.getByTestId('no-recommendations')).toBeInTheDocument();
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
