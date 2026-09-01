/**
 * Insight Engine — Champion Mastery sidebar section.
 *
 * User request: "add a section to sidebar for champion mastery, simply
 * outline the top 5 most mastery point champions and the user's winrate on
 * them, as well as amount of games played, average kda... under Champion
 * Preferences section and above role Performance section."
 *
 * PURE MODULE, same discipline as every other file in `backend/src/insight/`:
 * no network, cache, database, `process.env`, HTTP, logging, or wall-clock
 * read. `computeChampionMastery` only joins two already-fetched inputs —
 * the analyzed player's own match history and the Champion-Mastery-V4
 * top-N points Riot already returns sorted by `championPoints` descending —
 * by `championId`. The orchestrator (`orchestrator/index.ts`) owns fetching
 * and caching the mastery points; this module never sees a Riot response.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. NOT FILTERED BY THE SIDEBAR'S QUEUE TAB. Champion mastery points/level
 *    are a Riot-side lifetime figure with no queue dimension at all, so
 *    filtering the games/winrate/KDA half of this section by queue while the
 *    mastery-points half stays global would be an inconsistent hybrid. Reads
 *    the same full merged window (Summoner's Rift + ARAM/ARAM Mayhem)
 *    `funFactsV2.ts` already reads, for the same reason — this is a
 *    lifetime-habit section, not a current-form one (that's Performance
 *    Feedback's job).
 *
 * 2. A CHAMPION WITH ZERO MATCHES IN THE WINDOW STILL APPEARS, WITH `null`
 *    `winRatePercent`/`averageKda`. Mastery points can predate the window
 *    (up to `MATCH_HISTORY_COUNT` matches) by seasons — a top-mastery
 *    champion the player has not touched recently is still a true fact about
 *    their mastery standing and should not silently vanish from a top-5 list
 *    just because this window has no games to average. The frontend decides
 *    how to render `null` (e.g. "no recent games").
 *
 * 3. A MATCH WITH NO `championId` (an older cached match, from before this
 *    field was threaded onto `RawMatch`/`LanelessMatch`) NEVER JOINS ANY
 *    ENTRY. `championId === points.championId` is `false` for `undefined ===
 *    number`, so such a match is silently excluded from every champion's
 *    count rather than crashing or joining the wrong champion — the same
 *    degrade-gracefully contract every other optional field on these types
 *    already has.
 */

import { averageKdaOf, roundHalfUp, type IncludedMatch, type LanelessMatch } from './stats';

/** How many top-mastery champions the sidebar section shows. */
export const CHAMPION_MASTERY_TOP_COUNT = 5;

/** The Champion-Mastery-V4 fields this module needs — see `orchestrator/index.ts#fetchChampionMasteryTop`. */
export interface ChampionMasteryPoints {
  championId: number;
  championLevel: number;
  championPoints: number;
}

export interface ChampionMasteryEntry extends ChampionMasteryPoints {
  gamesPlayed: number;
  /** `null` when `gamesPlayed` is 0 (decision 2) — never a numeric `0`, which would misread as an actual 0% record. */
  winRatePercent: number | null;
  averageKda: number | null;
}

/** Decision 1: a Laneless_Match has no lane; only `championId` matters here. */
function lanelessAsIncludedMatch(match: LanelessMatch): IncludedMatch {
  return {
    matchId: match.matchId,
    queueType: match.queueType,
    startTimestamp: match.startTimestamp,
    durationSeconds: match.durationSeconds,
    championName: match.championName,
    championId: match.championId,
    role: '',
    win: match.win,
    kills: match.kills,
    deaths: match.deaths,
    assists: match.assists,
    visionScore: match.visionScore,
    cs: match.cs,
    build: match.build,
    participants: match.participants,
  };
}

/**
 * Requirement (user request, 2026-09-01): joins `masteryPoints` — assumed
 * already the top `CHAMPION_MASTERY_TOP_COUNT` sorted by `championPoints`
 * descending, exactly what `getChampionMasteryTop(..., CHAMPION_MASTERY_TOP_COUNT)`
 * returns — against the analyzed player's own match history by `championId`.
 * Pure: depends only on its three arguments. `lanelessMatches` defaults to
 * `[]` so a caller with only Summoner's Rift data needs no change.
 */
export function computeChampionMastery(
  matches: readonly IncludedMatch[],
  masteryPoints: readonly ChampionMasteryPoints[],
  lanelessMatches: readonly LanelessMatch[] = [],
): ChampionMasteryEntry[] {
  const allMatches: readonly IncludedMatch[] = [...matches, ...lanelessMatches.map(lanelessAsIncludedMatch)];

  return masteryPoints.slice(0, CHAMPION_MASTERY_TOP_COUNT).map((points): ChampionMasteryEntry => {
    const championMatches = allMatches.filter((match) => match.championId === points.championId);
    const gamesPlayed = championMatches.length;
    if (gamesPlayed === 0) {
      return { ...points, gamesPlayed: 0, winRatePercent: null, averageKda: null }; // decision 2
    }
    const wins = championMatches.reduce((total, match) => total + (match.win ? 1 : 0), 0);
    return {
      ...points,
      gamesPlayed,
      winRatePercent: roundHalfUp((100 * wins) / gamesPlayed),
      averageKda: averageKdaOf(championMatches),
    };
  });
}
