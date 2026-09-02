/**
 * Insight Engine — LP gained/lost per ranked match, for Recent Matches.
 *
 * User request (2026-09-01): "on recent matches section, next to
 * match-queue-type, if it was a ranked soloduo or ranked flex game or ranked
 * 5s game, display LP gained or lost for the game."
 *
 * PURE MODULE, same discipline as every other file in `backend/src/insight/`:
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock
 * read. Every value is derived from the `matches`/`checkpoints` the caller
 * supplies (`orchestrator/index.ts` owns fetching/persisting the checkpoints
 * this reads — see `db/rankCheckpointStore.ts`'s header for why a checkpoint
 * exists at all and why most matches will have no delta).
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. WHEN MULTIPLE RANKED MATCHES OF THE SAME QUEUE FALL BETWEEN TWO ADJACENT
 *    CHECKPOINTS, THE OBSERVED ORDINAL CHANGE IS SPLIT ACROSS THEM BY RESULT —
 *    AN APPROXIMATION, ACKNOWLEDGED AS SUCH, NOT A CLAIM OF EXACTNESS.
 *    History: a strict "no delta for an ambiguous bracket" version; then
 *    (2026-09-01) an *even* split; then (2026-09-02) a result-aware split,
 *    because the even split showed `+LP on a defeat`; then (2026-09-02, this
 *    revision) a W/L-aware split plus remake exclusion.
 *
 *    The model: a win and a loss in the same bracket are assumed to move LP
 *    by the same magnitude `g` (true enough at a stable MMR). With `W` wins
 *    and `L` losses across the bracket and an observed delta `D`,
 *    `W·g − L·g = D`, so `g = trunc(D / (W − L))` when that quotient is
 *    positive (net change agrees with the win/loss balance); otherwise
 *    `g = round(|D| / (W + L))`, or `0` when `D == 0`. Each visible win is
 *    then `+g`, each visible loss `−g`.
 *
 *    `W` and `L` come from the checkpoints themselves when both carry
 *    League-V4's cumulative `wins`/`losses` (`RankCheckpoint`, added
 *    2026-09-02): `W = after.wins − before.wins`, `L = after.losses −
 *    before.losses`. This is the exact game count and split for the interval,
 *    independent of how many matches the lookup actually fetched. Falls back
 *    to counting the visible matches' `win` flags when a checkpoint predates
 *    that field.
 *
 *    RECONCILIATION. When every game in the bracket is visible (checkpoint
 *    `W + L` equals the visible match count, or W/L is unknown so we assume
 *    it), the small leftover `D − (W − L)·g` is handed out one point at a
 *    time — earliest WINS if positive, earliest LOSSES if negative — so the
 *    shown deltas sum to exactly `D`. When the checkpoints say more games
 *    happened than we can see, each visible game keeps its `±g` estimate and
 *    the remainder is left with the unseen games (the shown deltas then do
 *    NOT sum to `D`, by design).
 *
 *    HARD RULE, above sum-exactness: sign follows the game result — a win is
 *    never shown negative, a loss never positive. A leftover that cannot land
 *    without flipping a sign is dropped.
 *
 *    DECAY / ADJUSTMENTS. When the checkpoints carry W/L and report ZERO
 *    games in the interval but a non-zero `D` (LP decay, an MMR correction, a
 *    placement adjustment), the whole bracket is skipped — there is no game
 *    to attribute it to.
 *
 *    REMAKES. A match shorter than `REMAKE_MAX_DURATION_SECONDS` is a remake:
 *    0 LP, and not counted in League-V4's `wins`/`losses`. It is excluded
 *    from every bracket entirely and never gets a delta.
 *
 * 2. LP IS COMPARED AS A CUMULATIVE ORDINAL, NOT RAW `leaguePoints`. Gold IV
 *    90 LP -> Gold III 10 LP is a climb, but the raw LP number drops. Each
 *    checkpoint collapses to `tierRank * 400 + divisionRank * 100 +
 *    clamp(lp, 0..100)` (Master+: `7 * 400 + lp`, unbounded) — the exact same
 *    scale `frontend/src/domain/rankHistory.ts#rankOrdinal` already uses for
 *    the rank-history graph, intentionally kept in sync so "1 unit of ordinal
 *    difference" means the same thing in both places. Duplicated here rather
 *    than imported, since this module must stay import-free of frontend code
 *    (and of `db/rankCheckpointStore.ts`, which is why the checkpoint type is
 *    a small local shape, not that module's `RankCheckpoint`).
 *
 * 3. ONLY RANKED SOLO/DUO AND RANKED FLEX MATCHES CAN EVER GET A DELTA TODAY.
 *    The user asked for solo/duo, flex, AND "ranked 5s" — but no Match-V5
 *    queue id in `orchestrator/mapping.ts#QUEUE_TYPE_BY_QUEUE_ID` produces a
 *    match `queueType` for a 5v5 ranked-premade queue (it is a legacy League-V4
 *    queue type, `RANKED_PREMADE_5x5`, that can still appear as a ranked
 *    STANDING but not as a Match-V5 game today). `LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE`
 *    is written as an open map rather than hardcoded to two cases specifically
 *    so a third entry needs only one line added here, the day Riot's queue-id
 *    table (or this app's) grows one.
 */

/** Mirrors `frontend/src/domain/rankHistory.ts#rankOrdinal`'s tier scale — see decision 2. */
const TIER_RANK: Readonly<Record<string, number>> = {
  IRON: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4,
  EMERALD: 5,
  DIAMOND: 6,
  MASTER: 7,
  GRANDMASTER: 8,
  CHALLENGER: 9,
};

const DIVISION_RANK: Readonly<Record<string, number>> = { IV: 0, III: 1, II: 2, I: 3 };

const APEX_FLOOR = 7 * 400;

export interface RankOrdinalInput {
  tier: string;
  division: string;
  leaguePoints: number;
}

/** Decision 2. A higher return value always means a genuinely higher rank. */
export function rankOrdinalOf(entry: RankOrdinalInput): number {
  const tier = TIER_RANK[entry.tier.toUpperCase()] ?? 0;
  const lp = Number.isFinite(entry.leaguePoints) ? entry.leaguePoints : 0;

  if (tier >= TIER_RANK.MASTER) {
    return APEX_FLOOR + Math.max(0, lp);
  }
  const division = DIVISION_RANK[entry.division.toUpperCase()] ?? 0;
  return tier * 400 + division * 100 + Math.min(100, Math.max(0, lp));
}

/** Decision 3. Match `queueType` (`IncludedMatch.queueType`) -> the League-V4 `queueType` string that carries its LP. */
export const LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE: Readonly<Record<string, string>> = {
  'ranked solo/duo': 'RANKED_SOLO_5x5',
  'ranked flex': 'RANKED_FLEX_SR',
};

/** A match this short is a remake — 0 LP, absent from League-V4's win/loss tally. */
export const REMAKE_MAX_DURATION_SECONDS = 300;

export interface LpDeltaCheckpoint extends RankOrdinalInput {
  /** Raw League-V4 queue type string, e.g. `RANKED_SOLO_5x5`. */
  queueType: string;
  /**
   * League-V4 cumulative wins / losses for this queue at `observedAt`. Both
   * present, or both absent (a checkpoint written before the field existed).
   * When present on both ends of a bracket they give its exact game count and
   * win/loss split (decision 1).
   */
  wins?: number;
  losses?: number;
  observedAt: number;
}

export interface LpDeltaMatch {
  matchId: string;
  /** `IncludedMatch.queueType` — only entries in `LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE` can ever get a delta. */
  queueType: string;
  startTimestamp: number;
  durationSeconds: number;
  /** `IncludedMatch.win` — fixes the sign of this match's share (decision 1). */
  win: boolean;
}

/**
 * Decision 1. Attributes one bracket's observed ordinal change `totalDelta`
 * across its visible matches by result: every win ≥ 0, every loss ≤ 0.
 *
 * `trueCounts`, when given, is the bracket's real win/loss split from the
 * checkpoints (`after.wins − before.wins`, etc.). It drives the per-game
 * magnitude estimate and tells a complete bracket (all games visible) from one
 * with games the lookup never fetched — in the latter case the shares are the
 * `±g` estimate only and deliberately do NOT sum to `totalDelta`.
 *
 * Returns the per-match deltas in input order.
 */
export function attributeBracket(
  bracketMatches: readonly { matchId: string; endTimestamp: number; win: boolean }[],
  totalDelta: number,
  trueCounts?: { wins: number; losses: number },
): [string, number][] {
  const visibleWins = bracketMatches.filter((m) => m.win);
  const visibleLosses = bracketMatches.filter((m) => !m.win);
  const visibleCount = bracketMatches.length;
  if (visibleCount === 0) {
    return [];
  }

  // W / L for the magnitude estimate: the checkpoints when they carry it, else
  // the visible matches.
  const w = trueCounts ? trueCounts.wins : visibleWins.length;
  const l = trueCounts ? trueCounts.losses : visibleLosses.length;
  const total = w + l;

  let g: number;
  if (totalDelta === 0 || total === 0) {
    g = 0;
  } else if (w - l !== 0 && Math.sign(w - l) === Math.sign(totalDelta)) {
    // Consistent: net change agrees with the win/loss balance. `w·g − l·g = D`.
    g = Math.trunc(totalDelta / (w - l));
  } else {
    // `w == l`, or the checkpoint delta disagrees in sign with the balance.
    g = Math.round(Math.abs(totalDelta) / total);
  }

  const value = new Map<string, number>(bracketMatches.map((m) => [m.matchId, m.win ? g : -g]));

  // Reconcile the visible shares to exactly `totalDelta` only when every game in
  // the bracket is visible — no `trueCounts` (assume complete), or its total
  // equals the visible count. Otherwise the unseen games hold the remainder.
  const complete = trueCounts === undefined || total === visibleCount;
  if (complete) {
    let leftover = totalDelta - (visibleWins.length - visibleLosses.length) * g;
    if (leftover !== 0) {
      const step = Math.sign(leftover);
      const pool = (step > 0 ? visibleWins : visibleLosses)
        .slice()
        .sort((a, b) => a.endTimestamp - b.endTimestamp);
      for (let i = 0; leftover !== 0 && pool.length > 0; i += 1) {
        const m = pool[i % pool.length];
        value.set(m.matchId, (value.get(m.matchId) ?? 0) + step);
        leftover -= step;
      }
    }
  }

  return bracketMatches.map((m) => [m.matchId, value.get(m.matchId) ?? 0]);
}

/**
 * Requirement (user request, 2026-09-01; W/L-aware split + remake exclusion
 * added 2026-09-02 per decision 1). Pure: depends only on `matches` and
 * `checkpoints`. Returns a `matchId -> LP delta` map (positive = gained,
 * negative = lost). A match is absent from the map when it isn't a queue this
 * module tracks (decision 3), it is a remake (decision 1), its end falls outside
 * every recorded checkpoint window, or its bracket is pure LP decay (checkpoints
 * report zero games).
 */
export function computeLpDeltas(
  matches: readonly LpDeltaMatch[],
  checkpoints: readonly LpDeltaCheckpoint[],
): Map<string, number> {
  const result = new Map<string, number>();

  const checkpointsByQueue = new Map<string, LpDeltaCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    const bucket = checkpointsByQueue.get(checkpoint.queueType);
    if (bucket === undefined) {
      checkpointsByQueue.set(checkpoint.queueType, [checkpoint]);
    } else {
      bucket.push(checkpoint);
    }
  }
  for (const bucket of checkpointsByQueue.values()) {
    bucket.sort((a, b) => a.observedAt - b.observedAt);
  }

  const matchesByLeagueQueue = new Map<string, { matchId: string; endTimestamp: number; win: boolean }[]>();
  for (const match of matches) {
    const leagueQueueType = LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE[match.queueType];
    if (leagueQueueType === undefined) {
      continue; // decision 3: not (yet) a queue this module can attribute a delta to
    }
    if (match.durationSeconds < REMAKE_MAX_DURATION_SECONDS) {
      continue; // decision 1: a remake — 0 LP, and not in League-V4's win/loss tally
    }
    const endTimestamp = match.startTimestamp + match.durationSeconds * 1000;
    const bucket = matchesByLeagueQueue.get(leagueQueueType);
    const entry = { matchId: match.matchId, endTimestamp, win: match.win };
    if (bucket === undefined) {
      matchesByLeagueQueue.set(leagueQueueType, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  for (const [leagueQueueType, queueMatches] of matchesByLeagueQueue) {
    const queueCheckpoints = checkpointsByQueue.get(leagueQueueType);
    if (queueCheckpoints === undefined || queueCheckpoints.length < 2) {
      continue; // need at least two checkpoints to bracket anything
    }

    // Group matches by the exact (before, after) checkpoint pair that brackets
    // them, in end-timestamp order — decision 1 splits each bracket's total
    // delta across every match inside it.
    const byBracket = new Map<
      string,
      {
        before: LpDeltaCheckpoint;
        after: LpDeltaCheckpoint;
        matches: { matchId: string; endTimestamp: number; win: boolean }[];
      }
    >();
    for (const match of queueMatches) {
      let before: LpDeltaCheckpoint | undefined;
      let after: LpDeltaCheckpoint | undefined;
      for (const checkpoint of queueCheckpoints) {
        if (checkpoint.observedAt <= match.endTimestamp) {
          before = checkpoint;
        } else {
          after = checkpoint;
          break;
        }
      }
      if (before === undefined || after === undefined) {
        continue; // the match's end falls outside every recorded checkpoint window
      }
      const key = `${String(before.observedAt)}:${String(after.observedAt)}`;
      const existing = byBracket.get(key);
      if (existing === undefined) {
        byBracket.set(key, { before, after, matches: [match] });
      } else {
        existing.matches.push(match);
      }
    }

    for (const { before, after, matches: bracketMatches } of byBracket.values()) {
      const totalDelta = rankOrdinalOf(after) - rankOrdinalOf(before);

      // The bracket's true win/loss split, when both checkpoints carry League-V4
      // cumulative wins/losses (decision 1).
      let trueCounts: { wins: number; losses: number } | undefined;
      if (
        before.wins !== undefined &&
        before.losses !== undefined &&
        after.wins !== undefined &&
        after.losses !== undefined
      ) {
        const bracketWins = after.wins - before.wins;
        const bracketLosses = after.losses - before.losses;
        if (bracketWins >= 0 && bracketLosses >= 0) {
          if (bracketWins + bracketLosses === 0) {
            continue; // pure LP decay / MMR adjustment — no game to attribute it to
          }
          if (bracketWins + bracketLosses >= bracketMatches.length) {
            trueCounts = { wins: bracketWins, losses: bracketLosses };
          }
          // else: the checkpoints report fewer games than we can see — stale or
          // wrong W/L; fall back to counting the visible matches.
        }
        // A negative delta means a season/MMR reset fell between the checkpoints;
        // fall back too.
      }

      for (const [matchId, value] of attributeBracket(bracketMatches, totalDelta, trueCounts)) {
        result.set(matchId, value);
      }
    }
  }

  return result;
}
