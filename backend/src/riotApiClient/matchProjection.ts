/**
 * Match-V5 response projection.
 *
 * PURE MODULE. No I/O.
 *
 * Riot's `GET /lol/match/v5/matches/{matchId}` response is 50-120 KB: ten
 * participant objects of ~150 fields each, the bulk of it `challenges`,
 * `missions`, per-participant damage/healing/CC breakdowns and ping counters —
 * none of which this codebase reads. `MatchDto` / `MatchParticipantDto` in
 * `./index` declare exactly what IS read (~40 fields per participant).
 *
 * `projectMatchDto` reduces the raw response to that shape. `getMatchById`
 * applies it before returning, so **both** the in-memory Cache_Store and the
 * `specs/match-cache/` MatchStore hold the ~5 KB trimmed shape — and the
 * in-memory cache's footprint drops by the same factor.
 *
 * It is TOTAL: any input, including a malformed body, produces a well-formed
 * (if sparse) `MatchDto` rather than throwing. Required scalar fields are passed
 * through verbatim without defaulting — the same trust in Riot's contract that
 * `send()` already places in `data as T` — so a genuinely absent field flows
 * through as `undefined` and is excluded downstream exactly as it is today.
 *
 * The `MatchDto` types are imported type-only, so no runtime import cycle with
 * `./index` is created (`index.ts` imports the *value* `projectMatchDto` from
 * here; nothing this file imports survives compilation).
 */

import type { MatchDto, MatchParticipantDto } from './index';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Every field `MatchParticipantDto` declares; the projection copies exactly these. */
const PARTICIPANT_KEYS = [
  'puuid',
  'championName',
  'championId',
  'teamPosition',
  'role',
  'teamId',
  'win',
  'kills',
  'deaths',
  'assists',
  'visionScore',
  'totalMinionsKilled',
  'neutralMinionsKilled',
  'item0',
  'item1',
  'item2',
  'item3',
  'item4',
  'item5',
  'item6',
  'summoner1Id',
  'summoner2Id',
  'champLevel',
  'goldEarned',
  'totalDamageDealtToChampions',
  'turretKills',
  'dragonKills',
  'baronKills',
  'pentaKills',
  'riotIdGameName',
  'riotIdTagline',
  'playerAugment1',
  'playerAugment2',
  'playerAugment3',
  'playerAugment4',
  'playerAugment5',
  'playerAugment6',
] as const;

type PerkPage = NonNullable<MatchParticipantDto['perks']>;
type PerkStyle = NonNullable<PerkPage['styles']>[number];

function projectStyle(raw: unknown): PerkStyle {
  const style = asRecord(raw);
  return {
    description: style.description as string | undefined,
    style: style.style as number | undefined,
    selections: Array.isArray(style.selections)
      ? style.selections.map((selection) => ({ perk: asRecord(selection).perk as number | undefined }))
      : undefined,
  };
}

function projectPerks(raw: unknown): MatchParticipantDto['perks'] {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const perks = raw as Record<string, unknown>;
  const statPerks = perks.statPerks;
  const stat = statPerks !== null && typeof statPerks === 'object' ? (statPerks as Record<string, unknown>) : undefined;
  return {
    statPerks: stat
      ? {
          offense: stat.offense as number | undefined,
          flex: stat.flex as number | undefined,
          defense: stat.defense as number | undefined,
        }
      : undefined,
    styles: Array.isArray(perks.styles) ? perks.styles.map(projectStyle) : undefined,
  };
}

function projectParticipant(raw: unknown): MatchParticipantDto {
  const source = asRecord(raw);
  const projected: Partial<MatchParticipantDto> = {};
  for (const key of PARTICIPANT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      (projected as Record<string, unknown>)[key] = value;
    }
  }
  if (source.perks !== undefined) {
    projected.perks = projectPerks(source.perks);
  }
  return projected as MatchParticipantDto;
}

/**
 * Reduce a raw Match-V5 response to the `MatchDto` shape. Total over any input.
 */
export function projectMatchDto(raw: unknown): MatchDto {
  const root = asRecord(raw);
  const metadata = asRecord(root.metadata);
  const info = asRecord(root.info);
  const projectedInfo: MatchDto['info'] = {
    queueId: info.queueId as number,
    gameStartTimestamp: info.gameStartTimestamp as number,
    gameDuration: info.gameDuration as number,
    participants: Array.isArray(info.participants) ? info.participants.map(projectParticipant) : [],
  };
  if (info.gameMode !== undefined) {
    projectedInfo.gameMode = info.gameMode as string;
  }
  return {
    metadata: {
      matchId: metadata.matchId as string,
      participants: Array.isArray(metadata.participants)
        ? metadata.participants.filter((puuid): puuid is string => typeof puuid === 'string')
        : [],
    },
    info: projectedInfo,
  };
}
