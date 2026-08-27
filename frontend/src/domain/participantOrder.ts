/**
 * Shared participant grouping and ordering for the General and Runes tabs.
 *
 * `match-detail-tabs` Requirement 3.8/4.1 — the two tabs must display the same
 * ten Participants, grouped and ordered identically, so they cannot silently
 * drift apart. Both tabs import this one function rather than each computing
 * their own order.
 */

import type { MatchParticipant } from '../api/types';

/** Requirement 3.8's Position_Order: the five values Match-V5's `teamPosition` takes when assigned. */
export const POSITION_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

function positionRank(teamPosition: string): number {
  const index = POSITION_ORDER.indexOf(teamPosition as (typeof POSITION_ORDER)[number]);
  // Requirement 3.8: every Participant whose teamPosition is not one of the five
  // values is placed AFTER those whose is, preserving Riot's reported order among
  // them — a rank one past the last real position sorts every non-member last
  // without needing a second comparison branch.
  return index === -1 ? POSITION_ORDER.length : index;
}

/**
 * Sorts by Position_Order, stable — ties (including every non-member, which all
 * share the same out-of-range rank) keep Riot's reported relative order. Native
 * `Array.prototype.sort` has been a stable sort in every engine this application
 * targets for years, but the tiebreak is written explicitly rather than relied
 * on implicitly, so this function's own tests can verify it directly.
 */
function sortByPosition(participants: readonly MatchParticipant[]): MatchParticipant[] {
  return participants
    .map((participant, originalIndex) => ({ participant, originalIndex, rank: positionRank(participant.teamPosition) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.originalIndex - b.originalIndex))
    .map((entry) => entry.participant);
}

export interface TeamBlock {
  teamId: number;
  /** Requirement 3.1: true for exactly the block containing `isAnalyzedPlayer`. */
  isAnalyzedTeam: boolean;
  participants: MatchParticipant[];
}

/**
 * Requirement 3.1: two blocks by Team_Side, the Analyzed_Player's team first,
 * each internally ordered by `sortByPosition`. A match with fewer than ten
 * Participants (Requirement 6.11) or an unusual team-id set still groups
 * correctly — this makes no assumption beyond "however many distinct teamIds
 * are present, in this participant list".
 */
export function groupParticipantsByTeam(participants: readonly MatchParticipant[]): TeamBlock[] {
  const analyzedTeamId = participants.find((participant) => participant.isAnalyzedPlayer)?.teamId;
  const teamIds = [...new Set(participants.map((participant) => participant.teamId))];
  const orderedTeamIds =
    analyzedTeamId === undefined ? teamIds : [analyzedTeamId, ...teamIds.filter((teamId) => teamId !== analyzedTeamId)];

  return orderedTeamIds.map((teamId) => ({
    teamId,
    isAnalyzedTeam: teamId === analyzedTeamId,
    participants: sortByPosition(participants.filter((participant) => participant.teamId === teamId)),
  }));
}

/** A stable React key for a Participant — PUUIDs are never present (Requirement 6.6). */
export function participantKey(participant: MatchParticipant): string {
  return `${String(participant.teamId)}-${participant.riotIdGameName}#${participant.riotIdTagline}-${participant.championName}`;
}

/**
 * Requirement 9.2: a Rune_Page every field of which is the neutral "absent"
 * value is indistinguishable from a page with nothing to show — this is what
 * `runePageOf` (backend) produces when `perks` was absent or malformed, and it
 * is what the Runes tab uses to render "unavailable" instead of three empty
 * groups with no explanation.
 */
export function isRunePageUnavailable(runes: MatchParticipant['runes']): boolean {
  return (
    runes.primaryStyle === 0 &&
    runes.secondaryStyle === 0 &&
    runes.primarySelections.length === 0 &&
    runes.secondarySelections.length === 0
  );
}
