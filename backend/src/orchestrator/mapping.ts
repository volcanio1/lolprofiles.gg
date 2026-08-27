/**
 * Lookup Orchestrator — Riot wire schema to domain model mapping.
 *
 * PURE MODULE. No network, no cache, no `process.env`, no logging, no clock read.
 * The only imports are types.
 *
 * This is the boundary the Insight Engine was deliberately kept clear of (see
 * `insight/stats.ts` decisions 1 and 2): the Insight Engine consumes design.md's
 * `IncludedMatch` and `LeagueEntry`, while Riot speaks `MatchDto` and
 * `LeagueEntryDto`. Both translations live here, so Riot's field naming and queue
 * numbering are known in exactly one place.
 *
 * Implements:
 *  - 3.5: a match whose queue type is not "ranked solo/duo", "ranked flex" or
 *    "normal" is excluded from the Profile_Report and from the count that drives
 *    the limited-data notice.
 *  - 2.3 / 6.1: League-V4's `rank` field is the division the report displays.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. QUEUE CLASSIFICATION IS AN EXPLICIT ALLOWLIST OVER RIOT'S NUMERIC QUEUE IDS.
 *    Requirement 3.5 names three queue types, but Match-V5 reports
 *    `info.queueId`, a number. A mapping is therefore unavoidable. It is written
 *    as an allowlist rather than a denylist because the requirement is phrased as
 *    an exclusion rule: anything not recognized is excluded. That makes an
 *    unrecognized or newly introduced queue fail SAFE (dropped from analysis)
 *    rather than fail open (silently analyzed as if it were a standard game).
 *
 *    This does not contradict `insight/stats.ts` decision 3's refusal to hardcode
 *    a queue list. That decision concerns `rankedByQueue`'s KEY SET, which
 *    Requirement 6.1 scopes to "each queue type returned by League-V4" and which
 *    must therefore follow Riot's data. Here the requirement itself fixes a closed
 *    set of three, so the mapping is transcribing a requirement, not inventing a
 *    parallel source of truth.
 *
 * 2. WHICH QUEUE IDS COUNT AS "normal". The included ids and their descriptions
 *    in Riot's published queue table (queues.json) are:
 *      - 420 "5v5 Ranked Solo games"   (Summoner's Rift) -> ranked solo/duo
 *      - 440 "5v5 Ranked Flex games"   (Summoner's Rift) -> ranked flex
 *      - 400 "5v5 Draft Pick games"    (Summoner's Rift) -> normal
 *      - 430 "5v5 Blind Pick games"    (Summoner's Rift) -> normal
 *      - 480 "Swiftplay Games"         (Summoner's Rift) -> normal
 *      - 490 "Normal (Quickplay)"      (Summoner's Rift) -> normal
 *    The operational reading of "normal" is: a non-ranked 5v5 queue on Summoner's
 *    Rift with standard role assignment. That is what makes a match comparable to
 *    the ranked ones for the analysis the requirements ask for — Requirements 6.5,
 *    8.2 and 8.4 are all role-relative, so a mode without roles or lanes would
 *    corrupt them rather than add signal.
 *
 *    Consequently ARAM (450, Howling Abyss), Clash (700/720), Co-op vs AI, and
 *    every rotating game mode are excluded, as are all queue ids Riot marks
 *    deprecated. A newly introduced casual Summoner's Rift queue must be added
 *    here deliberately; until then its matches are excluded, per decision 1.
 *
 * 3. A MATCH WITH NO PARTICIPANT ROW FOR THE REQUESTER IS EXCLUDED. Every
 *    per-match statistic is read from the requester's own row in
 *    `info.participants`, located by PUUID. If that row is absent the match yields
 *    no usable data about this player, so it is excluded exactly as a fetch
 *    failure would be (Requirement 3.3).
 *
 *    This is defensive rather than routine, and deliberately so. It used to be a
 *    routinely reachable case: `deleteByPuuid` originally redacted the requester's
 *    PUUID out of RETAINED match details, so after a deletion request every one of
 *    that player's cached matches silently lost its row and was excluded forever —
 *    their report came back empty. Deletion now EVICTS those entries instead, so a
 *    later lookup re-fetches a complete match detail and the row is present again.
 *    The guard stays because Riot data can still surprise us (an anonymized or
 *    malformed participant list), and excluding one match is the right response to
 *    that; it should simply no longer fire because of a deletion.
 *
 * 4. RESPONSE SHAPES ARE VALIDATED HERE, NOT IN THE CLIENT. The Riot API Client
 *    casts response bodies without validating them, and explicitly defers
 *    field-level validation to "downstream, where a missing field has a meaning"
 *    (its decision 5). This module is that downstream: a malformed match is
 *    excluded, which is a meaning Requirement 3.3 already defines. `undefined` is
 *    returned instead of throwing, so one bad match can never fail a lookup.
 *
 * 5. `gameStartTimestamp` MUST BE FINITE; OTHER NUMBERS ARE COERCED TO 0. The
 *    start timestamp drives Requirement 7.1's time-of-day windows and 7.2's
 *    chronological ordering, and a non-finite value would silently corrupt both
 *    (NaN comparisons are false, so it would land in an arbitrary sort position),
 *    so such a match is excluded. A missing kill/death/assist/vision count, by
 *    contrast, has a well-defined neutral reading of 0 and cannot distort
 *    ordering, so it is coerced rather than causing an exclusion.
 *
 * 6. ROLE PREFERS `teamPosition`. Riot's `teamPosition` is the normalized lane
 *    assignment (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY); `role` is the older, coarser
 *    field (SOLO/CARRY/SUPPORT/DUO/NONE). `teamPosition` is used when non-blank,
 *    with `role` as a fallback and `''` if neither is usable. A blank role is
 *    handled downstream: `computeFunFacts` skips the role-preference statement for
 *    a blank role name rather than emitting a sentence about nothing.
 */

import {
  csPerMinuteOf,
  killParticipationOf,
  type IncludedMatch,
  type ItemBuild,
  type LanelessMatch,
  type LeagueEntry,
  type MatchParticipant,
  type OpponentSummary,
  type RunePage,
} from '../insight/stats';
import type { LeagueEntryDto, MatchDto, MatchParticipantDto } from '../riotApiClient';

/** The exact set Requirement 3.5 permits. */
export const ALLOWED_QUEUE_TYPES = ['ranked solo/duo', 'ranked flex', 'normal'] as const;

export type AllowedQueueType = (typeof ALLOWED_QUEUE_TYPES)[number];

/**
 * Riot `info.queueId` -> Requirement 3.5 queue type. See decision 2 for the
 * membership rule and the descriptions these ids carry in Riot's queue table.
 */
export const QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, AllowedQueueType>> = {
  400: 'normal', // 5v5 Draft Pick
  420: 'ranked solo/duo', // 5v5 Ranked Solo
  430: 'normal', // 5v5 Blind Pick
  440: 'ranked flex', // 5v5 Ranked Flex
  480: 'normal', // Swiftplay
  490: 'normal', // Normal (Quickplay)
};

/**
 * `match-detail-tabs` Requirement 11.1/11.2. Disjoint from `QUEUE_TYPE_BY_QUEUE_ID`
 * on purpose — that map's whole purpose (decision 2 above) is gating role-relative
 * computations a laneless match would corrupt, and these two ids must never join
 * it or `AllowedQueueType`. A separate map, read by a separate function
 * (`toLanelessMatch`), is what keeps a Laneless_Match out of every role-relative
 * computation by construction rather than by a runtime filter someone could forget.
 */
export const LANELESS_QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, 'aram' | 'aram mayhem'>> = {
  450: 'aram', // 5v5 ARAM
  2400: 'aram mayhem', // ARAM: Mayhem
};

/**
 * Requirement 3.5. Returns the allowed queue type for a Riot queue id, or
 * `undefined` when the queue is not one of the three permitted types — in which
 * case the match must be excluded from the report and from the limited-data count.
 */
export function queueTypeForQueueId(queueId: unknown): AllowedQueueType | undefined {
  if (typeof queueId !== 'number' || !Number.isFinite(queueId)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(QUEUE_TYPE_BY_QUEUE_ID, queueId)
    ? QUEUE_TYPE_BY_QUEUE_ID[queueId]
    : undefined;
}

/** Decision 5: a neutral 0 for any value that is not a finite number. */
function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Decision 6: normalized lane, falling back to Riot's older `role` field. */
function roleOf(participant: { teamPosition?: string; role?: string }): string {
  const teamPosition = typeof participant.teamPosition === 'string' ? participant.teamPosition.trim() : '';
  if (teamPosition.length > 0) {
    return teamPosition;
  }
  const role = typeof participant.role === 'string' ? participant.role.trim() : '';
  return role;
}

/** Minion + neutral-monster kills, coerced per decision 5. */
function csOf(participant: { totalMinionsKilled?: unknown; neutralMinionsKilled?: unknown }): number {
  return finiteOrZero(participant.totalMinionsKilled) + finiteOrZero(participant.neutralMinionsKilled);
}

/**
 * Requirement 3.1 / 3.5 / 3.6. Total and never throwing, matching this module's
 * existing contract: a malformed, absent or non-numeric slot becomes `0`, which is
 * already the encoding for "empty". Zeros are preserved rather than filtered, so a
 * gap in the inventory does not shift a later item into the wrong slot position.
 * `item6` is split into its own `trinket` field (design.md: "modelled as a slot,
 * not special-cased at the render site") so every call site gets the trinket
 * distinction for free instead of re-deriving it.
 */
export function itemBuildOf(participant: {
  item0?: unknown;
  item1?: unknown;
  item2?: unknown;
  item3?: unknown;
  item4?: unknown;
  item5?: unknown;
  item6?: unknown;
}): ItemBuild {
  return {
    items: [
      finiteOrZero(participant.item0),
      finiteOrZero(participant.item1),
      finiteOrZero(participant.item2),
      finiteOrZero(participant.item3),
      finiteOrZero(participant.item4),
      finiteOrZero(participant.item5),
    ],
    trinket: finiteOrZero(participant.item6),
  };
}

/**
 * The opposing participant sharing `player`'s lane, or `undefined` when none can
 * be identified — no lane could be determined for `player`, `teamId` is missing
 * or malformed on either side, or no other participant shares both the lane and
 * a different team.
 *
 * `match-detail-tabs` extracted this predicate verbatim out of `opponentOf` so a
 * second consumer (`toMatchParticipant`'s `isEnemyLaner` marker) could read the
 * same selection without re-deriving it — see that feature's design.md decision
 * on why matching by champion identifier is unsafe (Blind Pick permits mirror
 * picks). The predicate itself is byte-for-byte what `opponentOf` used inline
 * before the extraction; `mapping.test.ts`'s opponent tests, unchanged, are the
 * evidence of that.
 */
function opponentRowOf(
  participants: readonly MatchParticipantDto[],
  player: MatchParticipantDto,
): MatchParticipantDto | undefined {
  const lane = roleOf(player);
  if (lane === '' || typeof player.teamId !== 'number') {
    return undefined;
  }
  return participants.find(
    (candidate) =>
      candidate !== player &&
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof candidate.teamId === 'number' &&
      candidate.teamId !== player.teamId &&
      roleOf(candidate) === lane,
  );
}

/**
 * Summarizes an already-selected opponent row, or `undefined` when none was
 * selected. `rival` is `opponentRowOf`'s result — this function performs no
 * selection of its own, so `toIncludedMatch` can select once and hand the same
 * row to both this summary and `toMatchParticipant`'s `isEnemyLaner` marker.
 */
function opponentOf(rival: MatchParticipantDto | undefined, durationSeconds: number): OpponentSummary | undefined {
  if (rival === undefined) {
    return undefined;
  }
  const rivalCs = csOf(rival);
  return {
    championName: typeof rival.championName === 'string' ? rival.championName : '',
    kills: finiteOrZero(rival.kills),
    deaths: finiteOrZero(rival.deaths),
    assists: finiteOrZero(rival.assists),
    cs: rivalCs,
    csPerMinute: csPerMinuteOf(rivalCs, durationSeconds),
    visionScore: finiteOrZero(rival.visionScore),
    // Requirement 3.2/3.9: the SAME participant row this summary describes, never
    // a different one — `rival` is what `opponentRowOf`'s selection already chose.
    build: itemBuildOf(rival),
  };
}

/**
 * `match-detail-tabs` Requirement 6.2. All zero/blank when `perks` is absent or
 * malformed — never throws, matching this module's existing contract.
 */
function runePageOf(participant: MatchParticipantDto): RunePage {
  const perks = participant.perks;
  const styles = Array.isArray(perks?.styles) ? perks.styles : [];
  const primary = styles[0];
  const secondary = styles[1];
  const selectionsOf = (style: { selections?: { perk?: number }[] } | undefined): number[] =>
    Array.isArray(style?.selections)
      ? style.selections.map((selection) => finiteOrZero(selection?.perk)).filter((id) => id !== 0)
      : [];
  return {
    primaryStyle: finiteOrZero(primary?.style),
    secondaryStyle: finiteOrZero(secondary?.style),
    primarySelections: selectionsOf(primary),
    secondarySelections: selectionsOf(secondary),
    statShards: [
      finiteOrZero(perks?.statPerks?.offense),
      finiteOrZero(perks?.statPerks?.flex),
      finiteOrZero(perks?.statPerks?.defense),
    ],
  };
}

/**
 * `match-detail-tabs` Requirement 6. Total and never throwing, matching this
 * module's existing contract: a malformed, absent or non-numeric field becomes a
 * neutral value rather than an exclusion. `markers` is supplied by the caller,
 * which still has the PUUID and the `opponentRowOf` selection in scope — this
 * function itself never sees a PUUID and never derives either marker.
 */
export function toMatchParticipant(
  participant: MatchParticipantDto,
  markers: { isAnalyzedPlayer: boolean; isEnemyLaner: boolean },
  teamKills: number,
): MatchParticipant {
  const kills = finiteOrZero(participant.kills);
  const assists = finiteOrZero(participant.assists);
  return {
    isAnalyzedPlayer: markers.isAnalyzedPlayer,
    isEnemyLaner: markers.isEnemyLaner,
    teamId: finiteOrZero(participant.teamId),
    // Requirement 6.2: summonerName is deprecated and empty on current matches.
    riotIdGameName: typeof participant.riotIdGameName === 'string' ? participant.riotIdGameName : '',
    riotIdTagline: typeof participant.riotIdTagline === 'string' ? participant.riotIdTagline : '',
    championName: typeof participant.championName === 'string' ? participant.championName : '',
    champLevel: finiteOrZero(participant.champLevel),
    // Requirement 3.8/design.md: read DIRECTLY, never through `roleOf`, whose
    // fallback to Riot's coarser `role` field is a different vocabulary
    // (SOLO/CARRY/SUPPORT/DUO/NONE) from which no lane ordering is derivable.
    teamPosition: typeof participant.teamPosition === 'string' ? participant.teamPosition.trim() : '',
    summonerSpells: [finiteOrZero(participant.summoner1Id), finiteOrZero(participant.summoner2Id)],
    runes: runePageOf(participant),
    build: itemBuildOf(participant),
    kills,
    deaths: finiteOrZero(participant.deaths),
    assists,
    cs: csOf(participant),
    visionScore: finiteOrZero(participant.visionScore),
    damageToChampions: finiteOrZero(participant.totalDamageDealtToChampions),
    goldEarned: finiteOrZero(participant.goldEarned),
    win: participant.win === true,
    killParticipationPercent: killParticipationOf(kills, assists, teamKills),
    augments: augmentsOf(participant),
  };
}

/**
 * `match-detail-tabs` Requirement 12.1/12.2. Reading these fields is
 * unconditional — no queue check here — because Riot reports them as `0` in
 * every queue but 2400 (ARAM Mayhem), verified live against real ARAM matches.
 * A `0` slot is "not yet picked" (Requirement 12.9), never a value to keep.
 */
function augmentsOf(participant: MatchParticipantDto): readonly number[] {
  return [
    participant.playerAugment1,
    participant.playerAugment2,
    participant.playerAugment3,
    participant.playerAugment4,
    participant.playerAugment5,
    participant.playerAugment6,
  ]
    .map((id) => finiteOrZero(id))
    .filter((id) => id !== 0);
}

/**
 * `match-detail-tabs` Requirement 3.5. Sums kills per `teamId` across the
 * participants actually being displayed, rather than reading Riot's
 * `info.teams[].objectives.champion.kills` — see design.md decision 3: this keeps
 * a displayed Kill_Participation column self-consistent with the kills rendered
 * beside it, by construction, even in the (unobserved) case the two disagree.
 */
export function teamKillsOf(participants: readonly MatchParticipantDto[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const participant of participants) {
    if (participant === null || typeof participant !== 'object' || typeof participant.teamId !== 'number') {
      continue;
    }
    totals.set(participant.teamId, (totals.get(participant.teamId) ?? 0) + finiteOrZero(participant.kills));
  }
  return totals;
}

/**
 * Flattens a Match-V5 match detail into the analyzed player's own
 * `IncludedMatch`, or returns `undefined` when the match must be EXCLUDED:
 *
 *  - the queue type is not one of Requirement 3.5's three (decision 1/2)
 *  - the requester has no participant row in the match (decision 3)
 *  - the payload is not shaped like a `MatchDto`, or its start timestamp is not
 *    a finite number (decisions 4/5)
 *
 * Never throws: an unusable match is an exclusion, not a failure (Requirement 3.3).
 */
export function toIncludedMatch(match: MatchDto | undefined, puuid: string): IncludedMatch | undefined {
  if (match === null || typeof match !== 'object') {
    return undefined;
  }

  const info: unknown = match.info;
  if (info === null || typeof info !== 'object') {
    return undefined;
  }
  const typedInfo = info as MatchDto['info'];

  const queueType = queueTypeForQueueId(typedInfo.queueId);
  if (queueType === undefined) {
    return undefined;
  }

  const startTimestamp = typedInfo.gameStartTimestamp;
  if (typeof startTimestamp !== 'number' || !Number.isFinite(startTimestamp)) {
    return undefined;
  }

  const participants: unknown = typedInfo.participants;
  if (!Array.isArray(participants)) {
    return undefined;
  }
  const typedParticipants = participants as MatchDto['info']['participants'];
  const participant = typedParticipants.find(
    (candidate) => candidate !== null && typeof candidate === 'object' && candidate.puuid === puuid,
  );
  if (participant === undefined) {
    return undefined;
  }

  const metadata: unknown = match.metadata;
  const matchId =
    metadata !== null && typeof metadata === 'object' && typeof (metadata as MatchDto['metadata']).matchId === 'string'
      ? (metadata as MatchDto['metadata']).matchId
      : '';

  const durationSeconds = finiteOrZero(typedInfo.gameDuration);

  // One selection, two consumers (design.md decision 1): the opponent summary and
  // the `isEnemyLaner` marker both read the SAME row `opponentRowOf` chose, rather
  // than each re-deriving it or matching on champion identity (unsafe — Blind
  // Pick permits mirror picks).
  const rival = opponentRowOf(typedParticipants, participant);
  const teamKills = teamKillsOf(typedParticipants);

  return {
    matchId,
    queueType,
    startTimestamp,
    durationSeconds,
    championName: typeof participant.championName === 'string' ? participant.championName : '',
    role: roleOf(participant),
    win: participant.win === true,
    kills: finiteOrZero(participant.kills),
    deaths: finiteOrZero(participant.deaths),
    assists: finiteOrZero(participant.assists),
    visionScore: finiteOrZero(participant.visionScore),
    cs: csOf(participant),
    opponent: opponentOf(rival, durationSeconds),
    build: itemBuildOf(participant),
    participants: typedParticipants
      .filter((candidate): candidate is MatchParticipantDto => candidate !== null && typeof candidate === 'object')
      .map((candidate) =>
        toMatchParticipant(
          candidate,
          { isAnalyzedPlayer: candidate === participant, isEnemyLaner: rival !== undefined && candidate === rival },
          teamKills.get(typeof candidate.teamId === 'number' ? candidate.teamId : NaN) ?? 0,
        ),
      ),
  };
}

/**
 * `match-detail-tabs` Requirement 11. Parallel to `toIncludedMatch`, admitting
 * exactly the two queues `LANELESS_QUEUE_TYPE_BY_QUEUE_ID` lists — never touches
 * `QUEUE_TYPE_BY_QUEUE_ID` and is never called by anything that feeds a
 * role-relative computation. Never calls `opponentRowOf` or `opponentOf`: a
 * Laneless_Match has no lane, so `isEnemyLaner` is `false` on every participant
 * by construction, not because no opponent happened to be found.
 */
export function toLanelessMatch(match: MatchDto | undefined, puuid: string): LanelessMatch | undefined {
  if (match === null || typeof match !== 'object') {
    return undefined;
  }

  const info: unknown = match.info;
  if (info === null || typeof info !== 'object') {
    return undefined;
  }
  const typedInfo = info as MatchDto['info'];

  const queueType = LANELESS_QUEUE_TYPE_BY_QUEUE_ID[typedInfo.queueId];
  if (queueType === undefined) {
    return undefined;
  }

  const startTimestamp = typedInfo.gameStartTimestamp;
  if (typeof startTimestamp !== 'number' || !Number.isFinite(startTimestamp)) {
    return undefined;
  }

  const participants: unknown = typedInfo.participants;
  if (!Array.isArray(participants)) {
    return undefined;
  }
  const typedParticipants = participants as MatchDto['info']['participants'];
  const participant = typedParticipants.find(
    (candidate) => candidate !== null && typeof candidate === 'object' && candidate.puuid === puuid,
  );
  if (participant === undefined) {
    return undefined;
  }

  const metadata: unknown = match.metadata;
  const matchId =
    metadata !== null && typeof metadata === 'object' && typeof (metadata as MatchDto['metadata']).matchId === 'string'
      ? (metadata as MatchDto['metadata']).matchId
      : '';

  const durationSeconds = finiteOrZero(typedInfo.gameDuration);
  const teamKills = teamKillsOf(typedParticipants);

  return {
    matchId,
    queueType,
    startTimestamp,
    durationSeconds,
    championName: typeof participant.championName === 'string' ? participant.championName : '',
    win: participant.win === true,
    kills: finiteOrZero(participant.kills),
    deaths: finiteOrZero(participant.deaths),
    assists: finiteOrZero(participant.assists),
    visionScore: finiteOrZero(participant.visionScore),
    cs: csOf(participant),
    build: itemBuildOf(participant),
    participants: typedParticipants
      .filter((candidate): candidate is MatchParticipantDto => candidate !== null && typeof candidate === 'object')
      .map((candidate) =>
        toMatchParticipant(
          candidate,
          { isAnalyzedPlayer: candidate === participant, isEnemyLaner: false },
          teamKills.get(typeof candidate.teamId === 'number' ? candidate.teamId : NaN) ?? 0,
        ),
      ),
  };
}

/**
 * League-V4 `rank` -> design.md's `LeagueEntry.division`. The rename is the whole
 * mapping; every other field is already field-compatible (`insight/stats.ts`
 * decision 2).
 *
 * Non-string tier/division/queueType values become `''` and non-finite counts
 * become 0, for the same reason as decision 5: a malformed ranked entry should
 * render as an incomplete standing, never crash a report.
 */
export function toLeagueEntry(dto: LeagueEntryDto): LeagueEntry {
  return {
    queueType: typeof dto.queueType === 'string' ? dto.queueType : '',
    tier: typeof dto.tier === 'string' ? dto.tier : '',
    division: typeof dto.rank === 'string' ? dto.rank : '',
    leaguePoints: finiteOrZero(dto.leaguePoints),
    wins: finiteOrZero(dto.wins),
    losses: finiteOrZero(dto.losses),
  };
}

/**
 * Requirement 2.3 / 2.8. Maps a League-V4 response body to `LeagueEntry[]`.
 * A body that is not an array (malformed response) yields `[]`, which the
 * Insight Engine renders as Unranked — the same valid state Requirement 2.8
 * defines for a genuinely empty entry list, and never a failure.
 */
export function toLeagueEntries(dtos: LeagueEntryDto[] | undefined): LeagueEntry[] {
  if (!Array.isArray(dtos)) {
    return [];
  }
  return dtos
    .filter((dto): dto is LeagueEntryDto => dto !== null && typeof dto === 'object')
    .map(toLeagueEntry);
}
