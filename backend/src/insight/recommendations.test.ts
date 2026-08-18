import { describe, it, expect } from 'vitest';
import {
  CHAMPION_WIN_RATE_GAP_THRESHOLD,
  MAX_RECOMMENDATIONS,
  METRIC_NAMES,
  RECOMMENDATION_CATEGORY_ORDER,
  championSelectionRecommendationOf,
  computeRecommendations,
  survivabilityRecommendationOf,
  visionControlRecommendationOf,
} from './recommendations';
import { computeStats, type IncludedMatch } from './stats';

/**
 * Example tests for Requirements 8.1-8.5.
 *
 * `computeRecommendations` takes design.md's declared `(matches, stats)`
 * signature, so every call goes through `run`, which builds the `ProfileStats`
 * argument with the real `computeStats` (no league entries are needed: none of
 * Requirements 8.2-8.4 reads ranked standings).
 */

const BASE: Omit<IncludedMatch, 'matchId'> = {
  queueType: 'ranked solo/duo',
  startTimestamp: 1_609_459_200_000,
  durationSeconds: 1800,
  championName: 'Ahri',
  role: 'MIDDLE',
  win: true,
  kills: 5,
  deaths: 2,
  assists: 5,
  visionScore: 20,
};

let nextId = 0;
function match(overrides: Partial<IncludedMatch> = {}): IncludedMatch {
  nextId += 1;
  return { ...BASE, matchId: `M${nextId}`, ...overrides };
}

function run(matches: readonly IncludedMatch[]) {
  return computeRecommendations(matches, computeStats(matches, [], 'puuid'));
}

function categoriesOf(matches: readonly IncludedMatch[]): string[] {
  return run(matches).map((r) => r.category);
}

describe('survivability (Requirement 8.2)', () => {
  it('fires when the overall average deaths exceeds the most-played-role average', () => {
    // MIDDLE is most played (3 of 5) with 1 death per match; the 2 TOP matches
    // drag the overall average up to 3.0, above the 1.0 role baseline.
    const matches = [
      match({ role: 'MIDDLE', deaths: 1 }),
      match({ role: 'MIDDLE', deaths: 1 }),
      match({ role: 'MIDDLE', deaths: 1 }),
      match({ role: 'TOP', deaths: 6 }),
      match({ role: 'TOP', deaths: 6 }),
    ];

    const recommendation = survivabilityRecommendationOf(matches);
    expect(recommendation).toBeDefined();
    expect(recommendation?.category).toBe('survivability');
    expect(recommendation?.metricName).toBe(METRIC_NAMES.survivability);
    expect(recommendation?.metricValue).toBe(3);
    expect(recommendation?.text).toContain('MIDDLE');
    expect(categoriesOf(matches)).toContain('survivability');
  });

  it('does not fire for a single-role window, where the averages are equal by construction', () => {
    // Documented decision 3: one role means overall average === role average, so
    // the strict "exceeds" of Requirement 8.2 can never hold.
    const matches = [
      match({ role: 'MIDDLE', deaths: 9 }),
      match({ role: 'MIDDLE', deaths: 12 }),
      match({ role: 'MIDDLE', deaths: 1 }),
    ];

    expect(survivabilityRecommendationOf(matches)).toBeUndefined();
    expect(categoriesOf(matches)).not.toContain('survivability');
  });

  it('does not fire when the overall average exactly equals the role average across two roles', () => {
    // MIDDLE (3 matches) averages 4 deaths; the TOP matches also average 4, so
    // the overall average is exactly 4 — equal, not exceeding.
    const matches = [
      match({ role: 'MIDDLE', deaths: 3 }),
      match({ role: 'MIDDLE', deaths: 4 }),
      match({ role: 'MIDDLE', deaths: 5 }),
      match({ role: 'TOP', deaths: 4 }),
      match({ role: 'TOP', deaths: 4 }),
    ];

    expect(survivabilityRecommendationOf(matches)).toBeUndefined();
  });

  it('does not fire when the overall average is below the role average', () => {
    const matches = [
      match({ role: 'MIDDLE', deaths: 8 }),
      match({ role: 'MIDDLE', deaths: 8 }),
      match({ role: 'MIDDLE', deaths: 8 }),
      match({ role: 'TOP', deaths: 0 }),
      match({ role: 'TOP', deaths: 0 }),
    ];

    expect(survivabilityRecommendationOf(matches)).toBeUndefined();
  });
});

describe('champion selection (Requirement 8.3)', () => {
  /**
   * 3 games on `top` and 2 on `second`, so `topChampionsOf` ranks them in that
   * order by games played, with the requested whole-percent win rates.
   */
  function championWindow(topWinRate: 0 | 33 | 67 | 100, secondWins: 0 | 1 | 2): IncludedMatch[] {
    const topWins = { 0: 0, 33: 1, 67: 2, 100: 3 }[topWinRate];
    const matches: IncludedMatch[] = [];
    for (let i = 0; i < 3; i += 1) {
      matches.push(match({ championName: 'Ahri', win: i < topWins }));
    }
    for (let i = 0; i < 2; i += 1) {
      matches.push(match({ championName: 'Zed', win: i < secondWins }));
    }
    return matches;
  }

  it('fires when the gap exceeds 10 percentage points', () => {
    // Ahri 33% over 3 games, Zed 50% over 2 games -> a 17-point gap.
    const matches = championWindow(33, 1);
    const recommendation = championSelectionRecommendationOf(matches);

    expect(recommendation).toBeDefined();
    expect(recommendation?.category).toBe('championSelection');
    expect(recommendation?.metricName).toBe(METRIC_NAMES.championSelection);
    expect(recommendation?.metricValue).toBe(33);
    expect(recommendation?.text).toContain('Ahri');
    expect(recommendation?.text).toContain('Zed');
  });

  it('does not fire at a gap of exactly 10 percentage points', () => {
    // 4 games on Ahri at 50% (2 of 4) and 5 games on Zed at 60% (3 of 5) is a
    // 10-point gap; games played puts Zed first, so build the reverse: Zed is the
    // most-played at 50% and Ahri second at 60%.
    const matches: IncludedMatch[] = [];
    for (let i = 0; i < 4; i += 1) {
      matches.push(match({ championName: 'Zed', win: i < 2 })); // 50% over 4 games
    }
    for (let i = 0; i < 3; i += 1) {
      matches.push(match({ championName: 'Ahri', win: i < 2 })); // 67% over 3 games
    }
    // Zed 50%, Ahri 67% -> 17-point gap, which DOES fire; assert that first so
    // the boundary case below is known to differ only in the gap size.
    expect(championSelectionRecommendationOf(matches)).toBeDefined();

    const boundary: IncludedMatch[] = [];
    for (let i = 0; i < 10; i += 1) {
      boundary.push(match({ championName: 'Zed', win: i < 5 })); // 50% over 10 games
    }
    for (let i = 0; i < 5; i += 1) {
      boundary.push(match({ championName: 'Ahri', win: i < 3 })); // 60% over 5 games
    }
    expect(championSelectionRecommendationOf(boundary)).toBeUndefined();
    expect(CHAMPION_WIN_RATE_GAP_THRESHOLD).toBe(10);
  });

  it('does not fire when the most-played champion has the higher win rate', () => {
    const matches = championWindow(100, 0);
    expect(championSelectionRecommendationOf(matches)).toBeUndefined();
  });

  it('does not fire with only one distinct champion, however bad the win rate', () => {
    const matches = [
      match({ championName: 'Ahri', win: false }),
      match({ championName: 'Ahri', win: false }),
      match({ championName: 'Ahri', win: false }),
    ];

    expect(championSelectionRecommendationOf(matches)).toBeUndefined();
    expect(categoriesOf(matches)).not.toContain('championSelection');
  });
});

describe('vision control (Requirement 8.4)', () => {
  it('fires when the overall average vision score is strictly below the role median', () => {
    // MIDDLE is most played (3 of 5) with vision scores 30/40/50 -> median 40.
    // The two TOP matches at 0 pull the overall average to 24, below 40.
    const matches = [
      match({ role: 'MIDDLE', visionScore: 30 }),
      match({ role: 'MIDDLE', visionScore: 40 }),
      match({ role: 'MIDDLE', visionScore: 50 }),
      match({ role: 'TOP', visionScore: 0 }),
      match({ role: 'TOP', visionScore: 0 }),
    ];

    const recommendation = visionControlRecommendationOf(matches);
    expect(recommendation).toBeDefined();
    expect(recommendation?.category).toBe('visionControl');
    expect(recommendation?.metricName).toBe(METRIC_NAMES.visionControl);
    expect(recommendation?.metricValue).toBe(24);
  });

  it('does not fire when the overall average exactly equals the role median', () => {
    // A single-role window with a symmetric sample: average === median === 40.
    const matches = [
      match({ role: 'MIDDLE', visionScore: 30 }),
      match({ role: 'MIDDLE', visionScore: 40 }),
      match({ role: 'MIDDLE', visionScore: 50 }),
    ];

    expect(visionControlRecommendationOf(matches)).toBeUndefined();
  });

  it('does not fire when the overall average is above the role median', () => {
    const matches = [
      match({ role: 'MIDDLE', visionScore: 10 }),
      match({ role: 'MIDDLE', visionScore: 10 }),
      match({ role: 'MIDDLE', visionScore: 10 }),
      match({ role: 'TOP', visionScore: 90 }),
      match({ role: 'TOP', visionScore: 90 }),
    ];

    expect(visionControlRecommendationOf(matches)).toBeUndefined();
  });
});

describe('computeRecommendations assembly (Requirements 8.1, 8.5)', () => {
  it('returns all three recommendations, in the fixed category order, when all three trigger', () => {
    // MIDDLE is most played (3 of 5): deaths 1 each (role baseline 1.0, overall
    // 3.0 -> survivability), vision 30/40/50 (median 40, overall 24 -> vision),
    // and Ahri (3 games, 33%) vs Zed (2 games, 50%) -> champion selection.
    const matches = [
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 30, win: true }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 40, win: false }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 50, win: false }),
      match({ role: 'TOP', championName: 'Zed', deaths: 6, visionScore: 0, win: true }),
      match({ role: 'TOP', championName: 'Zed', deaths: 6, visionScore: 0, win: false }),
    ];

    const recommendations = run(matches);
    expect(recommendations.map((r) => r.category)).toEqual([
      'survivability',
      'championSelection',
      'visionControl',
    ]);
    expect(recommendations).toHaveLength(3);
    expect(recommendations.length).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);

    for (const recommendation of recommendations) {
      expect(recommendation.text.length).toBeGreaterThan(0);
      expect(recommendation.metricName.length).toBeGreaterThan(0);
      expect(Number.isFinite(recommendation.metricValue)).toBe(true);
    }
    const byCategory = new Map(recommendations.map((r) => [r.category, r]));
    expect(byCategory.get('survivability')?.metricValue).toBe(3);
    expect(byCategory.get('championSelection')?.metricValue).toBe(33);
    expect(byCategory.get('visionControl')?.metricValue).toBe(24);
  });

  it('returns an empty array when no trigger condition holds (amended Requirement 8.1)', () => {
    const matches = [
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 2, visionScore: 40, win: true }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 2, visionScore: 40, win: true }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 2, visionScore: 40, win: true }),
    ];

    expect(run(matches)).toEqual([]);
  });

  it('returns an empty array for an empty match window', () => {
    expect(run([])).toEqual([]);
  });

  it('is deterministic and order-stable across repeated calls and shuffled input', () => {
    const matches = [
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 30, win: true }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 40, win: false }),
      match({ role: 'MIDDLE', championName: 'Ahri', deaths: 1, visionScore: 50, win: false }),
      match({ role: 'TOP', championName: 'Zed', deaths: 6, visionScore: 0, win: true }),
      match({ role: 'TOP', championName: 'Zed', deaths: 6, visionScore: 0, win: false }),
    ];

    const first = run(matches);
    expect(run(matches)).toEqual(first);
    expect(run([...matches].reverse()).map((r) => r.category)).toEqual(
      first.map((r) => r.category),
    );
    expect(first.map((r) => r.category)).toEqual(
      RECOMMENDATION_CATEGORY_ORDER.filter((c) => first.some((r) => r.category === c)),
    );
  });
});
