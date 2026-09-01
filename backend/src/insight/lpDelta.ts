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
 *    CHECKPOINTS, THE OBSERVED ORDINAL CHANGE IS SPLIT EVENLY ACROSS THEM —
 *    AN APPROXIMATION, ACKNOWLEDGED AS SUCH, NOT A CLAIM OF EXACTNESS.
 *    Amended 2026-09-01 ("let's change it, to approximate gaps between two
 *    snapshots, this isn't truly ideal") from an earlier, stricter version
 *    that left every match in an ambiguous bracket with no delta at all.
 *    `Math.trunc(totalDelta / count)` is each match's base share; the
 *    remainder (`totalDelta - base * count`, at most `count - 1` in
 *    magnitude) is handed one extra point at a time to the earliest matches
 *    in the bracket (by `endTimestamp`), so the displayed deltas always sum
 *    to exactly the real observed change between the two checkpoints — only
 *    which match "really" earned which share within that sum is a guess.
 *    A single match in a bracket is the special case `count === 1`, still
 *    exact (unchanged from before this amendment).
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

export interface LpDeltaCheckpoint extends RankOrdinalInput {
  /** Raw League-V4 queue type string, e.g. `RANKED_SOLO_5x5`. */
  queueType: string;
  observedAt: number;
}

export interface LpDeltaMatch {
  matchId: string;
  /** `IncludedMatch.queueType` — only entries in `LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE` can ever get a delta. */
  queueType: string;
  startTimestamp: number;
  durationSeconds: number;
}

/**
 * Requirement (user request, 2026-09-01; amended same day per decision 1).
 * Pure: depends only on `matches` and `checkpoints`. Returns a `matchId -> LP
 * delta` map (positive = gained, negative = lost) — exact when a match is the
 * only one of its queue between two adjacent checkpoints, an even-split
 * approximation otherwise. A match is absent from the map only when it isn't
 * a queue this module tracks (decision 3), or its end falls outside every
 * recorded checkpoint window for that queue (nothing to bracket it with).
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

  const matchesByLeagueQueue = new Map<string, { matchId: string; endTimestamp: number }[]>();
  for (const match of matches) {
    const leagueQueueType = LEAGUE_QUEUE_TYPE_BY_MATCH_QUEUE_TYPE[match.queueType];
    if (leagueQueueType === undefined) {
      continue; // decision 3: not (yet) a queue this module can attribute a delta to
    }
    const endTimestamp = match.startTimestamp + match.durationSeconds * 1000;
    const bucket = matchesByLeagueQueue.get(leagueQueueType);
    const entry = { matchId: match.matchId, endTimestamp };
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
      { before: LpDeltaCheckpoint; after: LpDeltaCheckpoint; matches: { matchId: string; endTimestamp: number }[] }
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
      const count = bracketMatches.length;
      const totalDelta = rankOrdinalOf(after) - rankOrdinalOf(before);
      const base = Math.trunc(totalDelta / count);
      let remainder = totalDelta - base * count; // decision 1: at most `count - 1` in magnitude

      const sorted = [...bracketMatches].sort((a, b) => a.endTimestamp - b.endTimestamp);
      for (const match of sorted) {
        const bump = remainder === 0 ? 0 : Math.sign(remainder);
        remainder -= bump;
        result.set(match.matchId, base + bump);
      }
    }
  }

  return result;
}
