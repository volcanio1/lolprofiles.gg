/**
 * champion-build-stats-pipeline: (match detail, timeline) -> one Observation per
 * human participant (task 7).
 *
 * PURE MODULE. No network, no clock, no store, no logging. Reuses the
 * item-timeline replay (`replayShopEvents`), the skill stream reader
 * (`extractSkillOrder`), the rune mapping (`runePageOf`), the shared
 * `maxOrderFromSkillOrder`, and the completed-item set.
 *
 * `[]` when the match is unusable — not queue 420, no parseable `gameVersion`,
 * or no participants.
 */

import type { MatchDto, MatchTimelineDto } from '../../riotApiClient';
import type { RunePage } from '../../insight/stats';
import { extractSkillOrder, replayShopEvents } from '../../insight/buildPath';
import { isCompletedItemId } from '../../insight/completedItems';
import { maxOrderFromSkillOrder } from '../../insight/skillOrder';
import { runePageOf } from '../../orchestrator/mapping';
import { CORE_ITEM_COUNT } from '../buildStatsConstants';
import type { SkillOrderValue } from './serialize';
import {
  RANKED_SOLO_QUEUE_ID,
  STARTING_EXCLUDED_ITEM_IDS,
  STARTING_ITEMS_CUTOFF_MS,
} from './constants';

export interface Observation {
  championKey: string;
  /** Raw `teamPosition` — `''` when Riot did not assign one. */
  role: string;
  win: boolean;
  /** `"major.minor"`, e.g. `"16.17"`. */
  patch: string;
  /** Completed items + boots, purchase order, length ≤ `CORE_ITEM_COUNT`. */
  itemPath: readonly number[];
  startingItems: readonly number[] | null;
  skillOrder: SkillOrderValue | null;
  runePage: RunePage | null;
  spellPair: readonly [number, number] | null;
}

/** `"16.17.412.9999"` -> `"16.17"`; `null` when unparseable. */
export function patchOf(gameVersion: string | undefined): string | null {
  if (typeof gameVersion !== 'string') {
    return null;
  }
  const match = /^(\d+)\.(\d+)/.exec(gameVersion.trim());
  return match === null ? null : `${match[1]}.${match[2]}`;
}

function isEmptyRunePage(runes: RunePage): boolean {
  return runes.primaryStyle === 0 && runes.primarySelections.length === 0;
}

export function extractObservations(match: MatchDto, timeline: MatchTimelineDto): Observation[] {
  if (match.info.queueId !== RANKED_SOLO_QUEUE_ID) {
    return [];
  }
  const patch = patchOf(match.info.gameVersion);
  if (patch === null) {
    return [];
  }

  // The authoritative slot map — `MatchTimelineDto` forbids assuming index + 1.
  const slotByPuuid = new Map<string, number>();
  for (const entry of timeline.info.participants ?? []) {
    if (typeof entry.puuid === 'string' && entry.puuid.length > 0 && Number.isFinite(entry.participantId)) {
      slotByPuuid.set(entry.puuid, entry.participantId);
    }
  }

  const events = (timeline.info.frames ?? []).flatMap((frame) => frame.events ?? []);
  const observations: Observation[] = [];

  for (const participant of match.info.participants ?? []) {
    const { puuid } = participant;
    if (typeof puuid !== 'string' || puuid.length === 0) {
      continue; // a bot, or an unidentified slot
    }
    const slot = slotByPuuid.get(puuid);
    if (slot === undefined) {
      continue;
    }

    const { buildPath } = replayShopEvents(events, slot);

    const itemPath = buildPath
      .map((entry) => entry.itemId)
      .filter(isCompletedItemId)
      .slice(0, CORE_ITEM_COUNT);

    const startingIds = buildPath
      .filter((entry) => entry.timestamp <= STARTING_ITEMS_CUTOFF_MS)
      .map((entry) => entry.itemId)
      .filter((id) => !STARTING_EXCLUDED_ITEM_IDS.has(id));

    const perLevel = extractSkillOrder(events, slot);
    const skillOrder: SkillOrderValue | null =
      perLevel.length > 0 ? { maxOrder: maxOrderFromSkillOrder(perLevel), perLevel } : null;

    const runes = runePageOf(participant);
    const runePage = isEmptyRunePage(runes) ? null : runes;

    const spell1 = participant.summoner1Id ?? 0;
    const spell2 = participant.summoner2Id ?? 0;
    const spellPair: readonly [number, number] | null =
      spell1 !== 0 && spell2 !== 0 ? [spell1, spell2] : null;

    observations.push({
      championKey: participant.championName,
      role: typeof participant.teamPosition === 'string' ? participant.teamPosition : '',
      win: participant.win === true,
      patch,
      itemPath,
      startingItems: startingIds.length > 0 ? startingIds : null,
      skillOrder,
      runePage,
      spellPair,
    });
  }

  return observations;
}
