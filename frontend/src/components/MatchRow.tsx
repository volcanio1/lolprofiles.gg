/**
 * The always-visible summary of one match in the recent-matches list — the
 * Analyzed_Player's side mirrored against the Enemy_Laner's, replacing the
 * former `RecentMatchCard`/`LaneStatsRow` table.
 *
 * `match-detail-tabs` task 5.1 — Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE OPPOSING SIDE'S SPELLS AND RUNES COME FROM
 * ---------------------------------------------------------------------------
 *
 * `match.opponent` (existing, from `visual-assets`) carries the Enemy_Laner's
 * line stats and Final_Build, but never their spells or runes — that data did
 * not exist anywhere in the application before this feature. It now lives on
 * `match.participants`, in the record `isEnemyLaner` marks (Requirement 6.7),
 * which this component looks up once and passes to the right-hand `MatchSide`.
 * The analyzed player's own spells/runes come the same way, from the record
 * `isAnalyzedPlayer` marks — the top-level `championName`/`kills`/etc. fields on
 * `RecentMatchSummary` are unchanged and still supply everything else.
 */

import { useState } from 'react';
import type { MatchParticipant, RecentMatchSummary, RiotIdParts } from '../api/types';
import { computeMatchRating } from '../domain/matchRating';
import { DetailPanel, type DetailTabKey } from './DetailPanel';
import { EMPTY_RUNE_PAGE, MatchSide } from './MatchSide';

const QUEUE_TYPE_LABELS: Readonly<Record<string, string>> = {
  'ranked solo/duo': 'Ranked Solo/Duo',
  'ranked flex': 'Ranked Flex',
  normal: 'Normal',
};

/** Requirement 1.6. Falls back to the raw value for a queue type this table does not name. */
export function matchQueueTypeLabel(queueType: string): string {
  return QUEUE_TYPE_LABELS[queueType] ?? queueType;
}

/** Requirement 1.6. `mm:ss`, e.g. `32:07`. Negative or non-finite durations read as `0:00`. */
export function formatMatchDuration(durationSeconds: number): string {
  const total = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.floor(durationSeconds) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

function formatMatchDate(epochMs: number): string {
  const parsed = new Date(epochMs);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

function findByMarker(
  participants: readonly MatchParticipant[],
  marker: 'isAnalyzedPlayer' | 'isEnemyLaner',
): MatchParticipant | undefined {
  return participants.find((participant) => participant[marker]);
}

export interface MatchRowProps {
  match: RecentMatchSummary;
  /** The searched player's Riot ID — threaded to the Build Path tab. */
  riotId: RiotIdParts;
}

export function MatchRow({ match, riotId }: MatchRowProps) {
  const analyzed = findByMarker(match.participants, 'isAnalyzedPlayer');
  const enemyLaner = findByMarker(match.participants, 'isEnemyLaner');

  const ratingOf = (participant: MatchParticipant | undefined) =>
    participant && match.participants.length > 0
      ? computeMatchRating(participant, match.participants, match.durationSeconds)
      : null;
  const playerRating = ratingOf(analyzed);
  const opponentRating = ratingOf(enemyLaner);

  // Requirement 2.2/2.4/2.5: collapsed on initial render; General selected on
  // first expansion; the LAST selected tab is what "restored on a later
  // expansion" means, in practice, since this state is never reset by collapsing
  // — only `expanded` changes, and `DetailPanel` unmounts without touching it.
  const [expanded, setExpanded] = useState(false);
  const [selectedTab, setSelectedTab] = useState<DetailTabKey>('general');
  const panelId = `match-detail-panel-${match.matchId}`;

  return (
    <li
      data-testid={`recent-match-${match.matchId}`}
      className={match.win ? 'match-row match-row--win' : 'match-row'}
    >
      <div className="match-head">
        <span className="match-outcome">{match.win ? 'Victory' : 'Defeat'}</span>
        {/* Requirement 11.5: '' covers both an undetermined role on a laned
            match and every Laneless_Match — neither has a role worth showing. */}
        {match.role !== '' ? <span className="match-role">{match.role}</span> : null}
        {/* Requirement 1.6 — not displayed before this feature. */}
        <span className="match-duration" data-testid={`recent-match-${match.matchId}-duration`}>
          {formatMatchDuration(match.durationSeconds)}
        </span>
        <span className="match-queue-type" data-testid={`recent-match-${match.matchId}-queue-type`}>
          {matchQueueTypeLabel(match.queueType)}
        </span>
        <span className="match-date">{formatMatchDate(match.startTimestamp)}</span>
        <button
          type="button"
          className="match-expand-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          data-testid={`recent-match-${match.matchId}-expand-toggle`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
      </div>

      <div className="match-mirror" data-testid={`recent-match-${match.matchId}-mirror`}>
        <MatchSide
          side="player"
          riotIdGameName={analyzed?.riotIdGameName ?? ''}
          riotIdTagline={analyzed?.riotIdTagline ?? ''}
          championName={match.championName}
          kills={match.kills}
          deaths={match.deaths}
          assists={match.assists}
          cs={match.cs}
          csPerMinute={match.csPerMinute}
          visionScore={match.visionScore}
          build={match.build}
          summonerSpells={analyzed?.summonerSpells ?? [0, 0]}
          runes={analyzed?.runes ?? EMPTY_RUNE_PAGE}
          rating={playerRating}
        />

        {match.opponent === null ? (
          // Requirement 1.7: the whole opposing side is replaced by this notice —
          // no empty opposing portrait, spells, runes, or item slots are rendered.
          <p
            data-testid={`recent-match-${match.matchId}-no-opponent`}
            className="matchup-note"
          >
            No lane opponent could be identified for this match.
          </p>
        ) : (
          <MatchSide
            side="opponent"
            riotIdGameName={enemyLaner?.riotIdGameName ?? ''}
            riotIdTagline={enemyLaner?.riotIdTagline ?? ''}
            championName={match.opponent.championName}
            kills={match.opponent.kills}
            deaths={match.opponent.deaths}
            assists={match.opponent.assists}
            cs={match.opponent.cs}
            csPerMinute={match.opponent.csPerMinute}
            visionScore={match.opponent.visionScore}
            build={match.opponent.build}
            summonerSpells={enemyLaner?.summonerSpells ?? [0, 0]}
            runes={enemyLaner?.runes ?? EMPTY_RUNE_PAGE}
            rating={opponentRating}
          />
        )}
      </div>

      {/* Requirement 2.1/2.2: the control above toggles this; collapsed means
          unmounted, not merely hidden, so a fetch-bearing tab (once item-timeline
          lands) never runs before its row is even opened. */}
      {expanded ? (
        <div id={panelId}>
          <DetailPanel match={match} riotId={riotId} selectedTab={selectedTab} onSelectTab={setSelectedTab} />
        </div>
      ) : null}
    </li>
  );
}
