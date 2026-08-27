/**
 * A 0–100 performance rating for one player in one match, for the General tab.
 *
 * Design (agreed with the user 2026-08-27):
 *
 *  - **Hybrid.** Each stat is scored against absolute, role-adjusted benchmarks
 *    (a "poor / good / great" curve), then the weighted blend is nudged by match
 *    context (a very short game compresses the spread, since the numbers mean
 *    less).
 *  - **Somewhat role-aware.** Support and jungle lean on kill participation,
 *    vision, and objectives; the lanes lean on CS, damage, and gold. One shared
 *    stat set, different weights per `teamPosition`.
 *  - **Outcome matters, lightly.** A win adds a small bonus; a loss caps the
 *    score below 100 (you can still be "great", just not perfect).
 *
 * PURE: a function of the participant, the other nine, and the game length. No
 * I/O, no clock — fully testable.
 */

import type { MatchParticipant } from '../api/types';

export type RatingTier = 'bad' | 'decent' | 'great';

export interface MatchRating {
  /** 1–100. */
  score: number;
  tier: RatingTier;
}

/** Colour bands: red below, grey through, gold (glowing) at or above. */
export const TIER_DECENT_MIN = 45;
export const TIER_GREAT_MIN = 75;

export function ratingTier(score: number): RatingTier {
  if (score >= TIER_GREAT_MIN) return 'great';
  if (score >= TIER_DECENT_MIN) return 'decent';
  return 'bad';
}

type Role = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | 'DEFAULT';

function roleOf(teamPosition: string): Role {
  switch (teamPosition) {
    case 'TOP':
    case 'JUNGLE':
    case 'MIDDLE':
    case 'BOTTOM':
    case 'UTILITY':
      return teamPosition;
    default:
      return 'DEFAULT';
  }
}

/** The seven scored metrics, in a fixed order. */
type Metric = 'kda' | 'kp' | 'csPerMin' | 'visionPerMin' | 'damageShare' | 'goldShare' | 'objectives';
const METRICS: readonly Metric[] = ['kda', 'kp', 'csPerMin', 'visionPerMin', 'damageShare', 'goldShare', 'objectives'];

/** Per-role weights over METRICS; each row sums to 1. */
const WEIGHTS: Readonly<Record<Role, Readonly<Record<Metric, number>>>> = {
  UTILITY: { kda: 0.14, kp: 0.24, csPerMin: 0.02, visionPerMin: 0.26, damageShare: 0.08, goldShare: 0.06, objectives: 0.2 },
  JUNGLE: { kda: 0.16, kp: 0.2, csPerMin: 0.1, visionPerMin: 0.14, damageShare: 0.14, goldShare: 0.06, objectives: 0.2 },
  MIDDLE: { kda: 0.2, kp: 0.14, csPerMin: 0.16, visionPerMin: 0.05, damageShare: 0.23, goldShare: 0.14, objectives: 0.08 },
  BOTTOM: { kda: 0.18, kp: 0.12, csPerMin: 0.18, visionPerMin: 0.04, damageShare: 0.24, goldShare: 0.14, objectives: 0.1 },
  TOP: { kda: 0.19, kp: 0.13, csPerMin: 0.16, visionPerMin: 0.05, damageShare: 0.2, goldShare: 0.13, objectives: 0.14 },
  DEFAULT: { kda: 0.2, kp: 0.18, csPerMin: 0.12, visionPerMin: 0.1, damageShare: 0.18, goldShare: 0.12, objectives: 0.1 },
};

/** Per-role "poor / good / great" breakpoints for each metric. */
const BENCHMARKS: Readonly<Record<Metric, Readonly<Record<Role, readonly [number, number, number]>>>> = {
  kda: {
    TOP: [1.5, 3, 5], JUNGLE: [1.5, 3, 5], MIDDLE: [1.6, 3.2, 5.2], BOTTOM: [1.6, 3.2, 5.4], UTILITY: [1.8, 3.4, 5.5], DEFAULT: [1.5, 3, 5],
  },
  kp: {
    TOP: [42, 56, 70], JUNGLE: [52, 68, 82], MIDDLE: [44, 58, 72], BOTTOM: [42, 56, 70], UTILITY: [55, 70, 84], DEFAULT: [45, 60, 74],
  },
  csPerMin: {
    TOP: [6, 7.8, 9.3], JUNGLE: [4.5, 6.3, 7.8], MIDDLE: [6.2, 8, 9.6], BOTTOM: [6.5, 8.3, 9.8], UTILITY: [0.5, 1.5, 3], DEFAULT: [5.5, 7.5, 9],
  },
  visionPerMin: {
    TOP: [0.5, 0.9, 1.4], JUNGLE: [1, 1.6, 2.2], MIDDLE: [0.5, 0.9, 1.4], BOTTOM: [0.4, 0.8, 1.3], UTILITY: [1.5, 2.4, 3.2], DEFAULT: [0.6, 1, 1.5],
  },
  damageShare: {
    TOP: [0.16, 0.22, 0.29], JUNGLE: [0.13, 0.19, 0.26], MIDDLE: [0.2, 0.27, 0.34], BOTTOM: [0.21, 0.28, 0.35], UTILITY: [0.06, 0.11, 0.17], DEFAULT: [0.15, 0.21, 0.29],
  },
  goldShare: {
    TOP: [0.18, 0.22, 0.27], JUNGLE: [0.16, 0.2, 0.25], MIDDLE: [0.19, 0.23, 0.28], BOTTOM: [0.2, 0.24, 0.29], UTILITY: [0.1, 0.13, 0.17], DEFAULT: [0.17, 0.21, 0.26],
  },
  // Weighted objective last-hits as a share of the team's total (turret + 2·dragon + 3·baron).
  objectives: {
    TOP: [0.05, 0.18, 0.4], JUNGLE: [0.12, 0.3, 0.55], MIDDLE: [0.04, 0.14, 0.32], BOTTOM: [0.04, 0.14, 0.32], UTILITY: [0.08, 0.24, 0.48], DEFAULT: [0.05, 0.16, 0.36],
  },
};

/**
 * Maps a value onto a 0.08..1 quality score via a piecewise-linear curve.
 * `good` is the anchor for a solid, average showing and sits near the middle of
 * the scale (~0.6); `poor`/`great` are the "clearly bad"/"clearly excellent"
 * marks. A value at exactly `poor` still scores ~0.32 so a single weak stat
 * doesn't crater the whole rating.
 */
function quality(value: number, [poor, good, great]: readonly [number, number, number]): number {
  if (!Number.isFinite(value) || value <= 0) return 0.08;
  if (value <= poor) return Math.max(0.08, 0.32 * (value / poor));
  if (value <= good) return 0.32 + 0.28 * ((value - poor) / (good - poor));
  if (value <= great) return 0.6 + 0.32 * ((value - good) / (great - good));
  return Math.min(1, 0.92 + 0.08 * ((value - great) / great));
}

function objectiveWeight(p: { turretKills: number; dragonKills: number; baronKills: number }): number {
  return p.turretKills + 2 * p.dragonKills + 3 * p.baronKills;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);
}

/**
 * @param participant       the player to rate
 * @param allParticipants   every participant in the match (both teams)
 * @param durationSeconds    game length; drives the per-minute metrics
 */
export function computeMatchRating(
  participant: MatchParticipant,
  allParticipants: readonly MatchParticipant[],
  durationSeconds: number,
): MatchRating {
  const role = roleOf(participant.teamPosition);
  const minutes = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds / 60 : 25;

  const team = allParticipants.filter((p) => p.teamId === participant.teamId);
  const teamDamage = sum(team.map((p) => p.damageToChampions)) || 1;
  const teamGold = sum(team.map((p) => p.goldEarned)) || 1;
  const teamObjectives = sum(team.map(objectiveWeight)) || 1;

  const kda = (participant.kills + participant.assists) / Math.max(participant.deaths, 1);
  const kp = participant.killParticipationPercent === 'N/A' ? 50 : participant.killParticipationPercent;

  const values: Record<Metric, number> = {
    kda,
    kp,
    csPerMin: participant.cs / minutes,
    visionPerMin: participant.visionScore / minutes,
    damageShare: participant.damageToChampions / teamDamage,
    goldShare: participant.goldEarned / teamGold,
    objectives: objectiveWeight(participant) / teamObjectives,
  };

  const weights = WEIGHTS[role];
  let base = 0;
  for (const metric of METRICS) {
    base += weights[metric] * quality(values[metric], BENCHMARKS[metric][role]);
  }

  let raw = base * 100;

  // Hybrid nudge: a very short game is noisy, so pull the score toward the middle.
  if (minutes < 15) {
    raw = 50 + (raw - 50) * 0.8;
  }

  // Outcome: a small win bonus; a loss cannot reach the top of the scale.
  if (participant.win) {
    raw += 3;
  }
  const ceiling = participant.win ? 100 : 95;
  const score = Math.max(1, Math.min(ceiling, Math.round(raw)));

  return { score, tier: ratingTier(score) };
}
