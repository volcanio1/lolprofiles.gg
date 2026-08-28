/**
 * A 0–100 performance rating for one player in one match, for the General tab.
 *
 * Design (agreed with the user 2026-08-28):
 *
 *  - **Role-shaped.** Laners are judged on CS/min, and on KDA and damage
 *    *relative to the lobby*; vision and kill participation barely count.
 *    Junglers lean on kill participation (70%+ is elite, never 100%), the
 *    team's objective control, CS, damage and KDA. Supports lean on vision,
 *    kill participation, objectives and KDA, with no CS component at all.
 *  - **Absolute benchmarks with a lobby overlay.** Each stat is scored against
 *    a "poor / good / great" curve; hitting the "great" mark scores full marks
 *    for that stat (10 CS/min, for instance, is the CS ceiling).
 *  - **Deaths matter on their own.** A low death rate is scored independently of
 *    KDA, and a net-negative K+A vs deaths line takes a flat penalty in any role.
 *  - **Outcome + carry.** A win adds a small bonus and lifts the ceiling to 100;
 *    leading your team in damage or KDA adds a carry bonus. Being ahead of every
 *    teammate on every tracked stat adds one final point (behind on all: −1).
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

type Metric =
  | 'kda'
  | 'kdaLobby'
  | 'kp'
  | 'csPerMin'
  | 'visionPerMin'
  | 'damageShare'
  | 'damageLobby'
  | 'goldShare'
  | 'goldEff'
  | 'teamObjShare'
  | 'lowDeaths';

/** Per-role weights; each row sums to 1. Metrics absent from a row score 0 weight. */
const WEIGHTS: Readonly<Record<Role, Partial<Record<Metric, number>>>> = {
  TOP: { csPerMin: 0.26, kdaLobby: 0.24, damageLobby: 0.22, goldEff: 0.08, lowDeaths: 0.06, kp: 0.07, visionPerMin: 0.07 },
  MIDDLE: { csPerMin: 0.26, kdaLobby: 0.24, damageLobby: 0.22, goldEff: 0.08, lowDeaths: 0.06, kp: 0.07, visionPerMin: 0.07 },
  BOTTOM: { csPerMin: 0.26, kdaLobby: 0.24, damageLobby: 0.22, goldEff: 0.08, lowDeaths: 0.06, kp: 0.07, visionPerMin: 0.07 },
  JUNGLE: { kp: 0.24, teamObjShare: 0.2, csPerMin: 0.14, damageLobby: 0.14, kdaLobby: 0.12, lowDeaths: 0.1, visionPerMin: 0.06 },
  UTILITY: { visionPerMin: 0.32, kp: 0.28, teamObjShare: 0.18, kda: 0.16, lowDeaths: 0.06 },
  DEFAULT: { kda: 0.2, kp: 0.16, csPerMin: 0.12, visionPerMin: 0.1, damageShare: 0.16, goldShare: 0.1, teamObjShare: 0.1, lowDeaths: 0.06 },
};

/** Per-role "poor / good / great" breakpoints. */
const BENCHMARKS: Readonly<Record<Metric, Readonly<Record<Role, readonly [number, number, number]>>>> = {
  kda: {
    TOP: [1.5, 3, 5], JUNGLE: [1.5, 3, 5], MIDDLE: [1.6, 3.2, 5.2], BOTTOM: [1.6, 3.2, 5.4], UTILITY: [1.8, 3.4, 5.5], DEFAULT: [1.5, 3, 5],
  },
  // Percentile within the ten-player lobby, 0 (worst) .. 1 (best).
  kdaLobby: {
    TOP: [0.33, 0.56, 0.85], JUNGLE: [0.33, 0.56, 0.85], MIDDLE: [0.33, 0.56, 0.85], BOTTOM: [0.33, 0.56, 0.85], UTILITY: [0.33, 0.56, 0.85], DEFAULT: [0.33, 0.56, 0.85],
  },
  kp: {
    TOP: [40, 52, 66], JUNGLE: [45, 58, 70], MIDDLE: [42, 54, 68], BOTTOM: [40, 52, 66], UTILITY: [48, 60, 72], DEFAULT: [42, 55, 68],
  },
  csPerMin: {
    TOP: [6, 8, 10], JUNGLE: [4.5, 6, 7.5], MIDDLE: [6.2, 8.2, 10], BOTTOM: [6.5, 8.5, 10], UTILITY: [0.3, 1, 2.5], DEFAULT: [5.5, 7.5, 9.5],
  },
  visionPerMin: {
    TOP: [0.5, 0.9, 1.4], JUNGLE: [1, 1.6, 2.2], MIDDLE: [0.5, 0.9, 1.4], BOTTOM: [0.4, 0.8, 1.3], UTILITY: [1.5, 2.4, 3.2], DEFAULT: [0.6, 1, 1.5],
  },
  damageShare: {
    TOP: [0.16, 0.22, 0.29], JUNGLE: [0.13, 0.19, 0.26], MIDDLE: [0.2, 0.27, 0.34], BOTTOM: [0.21, 0.28, 0.35], UTILITY: [0.06, 0.11, 0.17], DEFAULT: [0.15, 0.21, 0.29],
  },
  damageLobby: {
    TOP: [0.33, 0.56, 0.85], JUNGLE: [0.33, 0.56, 0.85], MIDDLE: [0.33, 0.56, 0.85], BOTTOM: [0.33, 0.56, 0.85], UTILITY: [0.33, 0.56, 0.85], DEFAULT: [0.33, 0.56, 0.85],
  },
  goldShare: {
    TOP: [0.18, 0.22, 0.27], JUNGLE: [0.16, 0.2, 0.25], MIDDLE: [0.19, 0.23, 0.28], BOTTOM: [0.2, 0.24, 0.29], UTILITY: [0.1, 0.13, 0.17], DEFAULT: [0.17, 0.21, 0.26],
  },
  // Damage to champions per gold earned, percentile within the lobby.
  goldEff: {
    TOP: [0.33, 0.56, 0.85], JUNGLE: [0.33, 0.56, 0.85], MIDDLE: [0.33, 0.56, 0.85], BOTTOM: [0.33, 0.56, 0.85], UTILITY: [0.33, 0.56, 0.85], DEFAULT: [0.33, 0.56, 0.85],
  },
  // Team's share of weighted objectives taken (turret + 2·dragon + 3·baron) vs the enemy team.
  teamObjShare: {
    TOP: [0.4, 0.55, 0.72], JUNGLE: [0.4, 0.55, 0.72], MIDDLE: [0.4, 0.55, 0.72], BOTTOM: [0.4, 0.55, 0.72], UTILITY: [0.4, 0.55, 0.72], DEFAULT: [0.4, 0.55, 0.72],
  },
  // Deaths per minute — lower is better, so these are [great, good, poor] ascending badness.
  lowDeaths: {
    TOP: [0.1, 0.25, 0.45], JUNGLE: [0.1, 0.25, 0.45], MIDDLE: [0.1, 0.25, 0.45], BOTTOM: [0.1, 0.25, 0.45], UTILITY: [0.12, 0.3, 0.5], DEFAULT: [0.1, 0.25, 0.45],
  },
};

/**
 * Maps a value onto a 0.10..1 quality score. `good` anchors a solid, average
 * showing (~0.70); `great` and anything beyond it scores a full 1.0.
 */
function quality(value: number, [poor, good, great]: readonly [number, number, number]): number {
  if (!Number.isFinite(value) || value <= 0) return 0.1;
  if (value <= poor) return Math.max(0.1, 0.3 * (value / poor));
  if (value <= good) return 0.3 + 0.4 * ((value - poor) / (good - poor));
  if (value <= great) return 0.7 + 0.3 * ((value - good) / (great - good));
  return 1;
}

/** As `quality`, but lower is better; breakpoints are [great, good, poor]. */
function qualityLow(value: number, [great, good, poor]: readonly [number, number, number]): number {
  if (!Number.isFinite(value) || value <= great) return 1;
  if (value <= good) return 0.7 + 0.3 * ((good - value) / (good - great));
  if (value <= poor) return 0.3 + 0.4 * ((poor - value) / (poor - good));
  return Math.max(0.1, (0.3 * poor) / value);
}

function objectiveWeight(p: { turretKills: number; dragonKills: number; baronKills: number }): number {
  return p.turretKills + 2 * p.dragonKills + 3 * p.baronKills;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);
}

function kdaOf(p: MatchParticipant): number {
  return (p.kills + p.assists) / Math.max(p.deaths, 1);
}

/** Fraction of the lobby this value beats, 0..1, splitting ties. */
function percentile(value: number, all: readonly number[]): number {
  const others = all.length - 1;
  if (others <= 0) return 0.5;
  let worse = 0;
  let equal = 0;
  for (const v of all) {
    if (v < value) worse += 1;
    else if (v === value) equal += 1;
  }
  return (worse + 0.5 * Math.max(0, equal - 1)) / others;
}

interface Ctx {
  role: Role;
  minutes: number;
  all: readonly MatchParticipant[];
  team: readonly MatchParticipant[];
  teamDamage: number;
  teamGold: number;
  teamObjShare: number;
  lobbyKda: readonly number[];
  lobbyDamage: readonly number[];
  lobbyGoldEff: readonly number[];
}

function metricValue(p: MatchParticipant, metric: Metric, ctx: Ctx): number {
  switch (metric) {
    case 'kda':
      return kdaOf(p);
    case 'kdaLobby':
      return percentile(kdaOf(p), ctx.lobbyKda);
    case 'kp':
      return p.killParticipationPercent === 'N/A' ? 50 : p.killParticipationPercent;
    case 'csPerMin':
      return p.cs / ctx.minutes;
    case 'visionPerMin':
      return p.visionScore / ctx.minutes;
    case 'damageShare':
      return p.damageToChampions / ctx.teamDamage;
    case 'damageLobby':
      return percentile(p.damageToChampions, ctx.lobbyDamage);
    case 'goldShare':
      return p.goldEarned / ctx.teamGold;
    case 'goldEff':
      return percentile(p.goldEarned > 0 ? p.damageToChampions / p.goldEarned : 0, ctx.lobbyGoldEff);
    case 'teamObjShare':
      return ctx.teamObjShare;
    case 'lowDeaths':
      return p.deaths / ctx.minutes;
  }
}

function metricQuality(p: MatchParticipant, metric: Metric, ctx: Ctx): number {
  const value = metricValue(p, metric, ctx);
  const bench = BENCHMARKS[metric][ctx.role];
  return metric === 'lowDeaths' ? qualityLow(value, bench) : quality(value, bench);
}

/**
 * @param participant      the player to rate
 * @param allParticipants  every participant in the match (both teams)
 * @param durationSeconds   game length; drives the per-minute metrics
 */
export function computeMatchRating(
  participant: MatchParticipant,
  allParticipants: readonly MatchParticipant[],
  durationSeconds: number,
): MatchRating {
  const role = roleOf(participant.teamPosition);
  const minutes = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds / 60 : 25;

  const team = allParticipants.filter((p) => p.teamId === participant.teamId);
  const enemy = allParticipants.filter((p) => p.teamId !== participant.teamId);
  const teamObj = sum(team.map(objectiveWeight));
  const enemyObj = sum(enemy.map(objectiveWeight));

  const ctx: Ctx = {
    role,
    minutes,
    all: allParticipants,
    team,
    teamDamage: sum(team.map((p) => p.damageToChampions)) || 1,
    teamGold: sum(team.map((p) => p.goldEarned)) || 1,
    teamObjShare: teamObj + enemyObj > 0 ? teamObj / (teamObj + enemyObj) : 0.5,
    lobbyKda: allParticipants.map(kdaOf),
    lobbyDamage: allParticipants.map((p) => p.damageToChampions),
    lobbyGoldEff: allParticipants.map((p) => (p.goldEarned > 0 ? p.damageToChampions / p.goldEarned : 0)),
  };

  const weights = WEIGHTS[role];
  const metrics = Object.keys(weights) as Metric[];

  let base = 0;
  for (const metric of metrics) {
    base += (weights[metric] ?? 0) * metricQuality(participant, metric, ctx);
  }

  let raw = base * 100;

  // Short game: fewer minutes, noisier numbers — pull toward the middle.
  if (minutes < 15) {
    raw = 50 + (raw - 50) * 0.8;
  }

  // Net-negative K+A vs deaths takes a flat hit in any role.
  const deficit = participant.deaths - participant.kills - participant.assists;
  if (deficit > 0) {
    raw -= Math.min(6, 2 + deficit * 0.6);
  }

  // Carry bonus: lead the team in damage or KDA (+4), or sit second (+2).
  const teamByDamage = [...team].sort((a, b) => b.damageToChampions - a.damageToChampions);
  const teamByKda = [...team].sort((a, b) => kdaOf(b) - kdaOf(a));
  const rankIn = (list: MatchParticipant[]) => list.indexOf(participant);
  const bestRank = Math.min(rankIn(teamByDamage), rankIn(teamByKda));
  if (bestRank === 0) raw += 4;
  else if (bestRank === 1) raw += 2;

  // Ahead of / behind every teammate on every tracked metric.
  const mates = team.filter((p) => p !== participant);
  if (mates.length > 0 && metrics.length > 0) {
    const mine = metrics.map((m) => metricQuality(participant, m, ctx));
    const aheadEverywhere = mates.every((mate) => metrics.every((m, i) => mine[i] > metricQuality(mate, m, ctx)));
    const behindEverywhere = mates.every((mate) => metrics.every((m, i) => mine[i] < metricQuality(mate, m, ctx)));
    if (aheadEverywhere) raw += 1;
    else if (behindEverywhere) raw -= 1;
  }

  // CS/min tiers (laners and junglers; supports never reach these).
  const csPerMin = participant.cs / minutes;
  if (csPerMin >= 11) raw += 5;
  else if (csPerMin >= 10) raw += 3;
  else if (csPerMin >= 9) raw += 2;
  else if (csPerMin >= 8) raw += 1;

  // Lobby-wide K/D/A extremes (only when there is an actual spread).
  const kills = allParticipants.map((p) => p.kills);
  const deaths = allParticipants.map((p) => p.deaths);
  const assists = allParticipants.map((p) => p.assists);
  const spread = (xs: number[]) => Math.max(...xs) !== Math.min(...xs);
  if (spread(kills)) {
    if (participant.kills === Math.max(...kills)) raw += 1;
    if (participant.kills === Math.min(...kills)) raw -= 1;
  }
  if (spread(deaths)) {
    if (participant.deaths === Math.max(...deaths)) raw -= 1;
    if (participant.deaths === Math.min(...deaths)) raw += 1;
  }
  if (spread(assists) && participant.assists === Math.max(...assists)) raw += 1;

  // Pentakills: flat +5 each, stacking.
  raw += 5 * (participant.pentaKills ?? 0);

  // Support: reward outperforming the enemy support directly.
  if (role === 'UTILITY') {
    const counterpart = enemy.find((p) => roleOf(p.teamPosition) === 'UTILITY');
    if (counterpart) {
      if (metrics.some((m) => metricQuality(participant, m, ctx) > metricQuality(counterpart, m, ctx))) raw += 1;
      if (participant.kills > counterpart.kills) raw += 1;
      if (participant.deaths < counterpart.deaths) raw += 1;
      const assistLead = participant.assists - counterpart.assists;
      if (assistLead > 0) raw += Math.min(3, 1 + Math.floor(assistLead / 8));
    }
  }

  if (participant.win) raw += 3;

  // Bonuses may push `raw` past the ceiling; a deserving game then rounds down
  // onto 100 rather than needing the weighted base alone to reach it.
  const ceiling = participant.win ? 100 : 97;
  const score = Math.max(1, Math.min(ceiling, Math.floor(raw)));

  return { score, tier: ratingTier(score) };
}
