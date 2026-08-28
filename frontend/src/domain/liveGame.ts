/**
 * live-game: pure display helpers for the Live Game view.
 *
 * No React, no I/O. Turns Spectator-V5's numeric queue ids and League-V4's
 * uppercase tier strings into the text the lobby renders.
 */

import type { LiveParticipantCard, LiveRankedEntry } from '../api/types';

/** Spectator-V5 `gameQueueConfigId` -> the League-V4 `queueType` whose entry the card shows. */
const RANKED_QUEUE_TYPE_BY_QUEUE_ID: Readonly<Record<number, string>> = {
  420: 'RANKED_SOLO_5x5',
  440: 'RANKED_FLEX_SR',
};

const QUEUE_LABELS: Readonly<Record<number, string>> = {
  400: 'Normal Draft',
  420: 'Ranked Solo/Duo',
  430: 'Normal Blind',
  440: 'Ranked Flex',
  450: 'ARAM',
  480: 'Swiftplay',
  490: 'Quickplay',
  700: 'Clash',
  1700: 'Arena',
  1900: 'URF',
  2400: 'ARAM Mayhem',
};

export function queueLabel(queueId: number): string {
  return QUEUE_LABELS[queueId] ?? `Queue ${queueId}`;
}

/** `GOLD` -> `Gold`, `RANKED_SOLO_5x5` untouched by callers — tiers only. */
export function titleCaseTier(tier: string): string {
  if (tier.length === 0) {
    return tier;
  }
  return tier[0].toUpperCase() + tier.slice(1).toLowerCase();
}

/**
 * The ranked entry a card should display for the game's queue: the matching
 * `queueType` when the game is ranked, otherwise `undefined` (a normal game has
 * no ranked standing to show).
 */
export function rankedEntryForGame(
  card: LiveParticipantCard,
  gameQueueId: number,
): LiveRankedEntry | undefined {
  const queueType = RANKED_QUEUE_TYPE_BY_QUEUE_ID[gameQueueId];
  if (queueType === undefined || card.rankedEntries === null) {
    return undefined;
  }
  return card.rankedEntries.find((entry) => entry.queueType === queueType);
}

/** `Gold II · 40 LP` for a ranked entry. */
export function formatRank(entry: LiveRankedEntry): string {
  const tier = titleCaseTier(entry.tier);
  const apex = entry.tier === 'MASTER' || entry.tier === 'GRANDMASTER' || entry.tier === 'CHALLENGER';
  return apex ? `${tier} · ${entry.leaguePoints} LP` : `${tier} ${entry.division} · ${entry.leaguePoints} LP`;
}

/** Champion mastery points, compact: `142,340` -> `142K`, `900` -> `900`. */
export function formatMasteryPoints(points: number): string {
  if (points >= 1000) {
    return `${Math.round(points / 1000)}K`;
  }
  return String(Math.max(0, Math.round(points)));
}

/** `iron`/`SILVER` -> `Silver – Diamond` for a lobby rank spread. */
export function formatRankSpread(spread: { highest: string; lowest: string }): string {
  return `${titleCaseTier(spread.lowest)} – ${titleCaseTier(spread.highest)}`;
}
