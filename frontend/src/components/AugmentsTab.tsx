/**
 * All ten players' champions and captured ARAM Mayhem augments — the third
 * tab's content for queue 2400 matches, in place of `RunesTab`.
 *
 * `match-detail-tabs` task 9.5 — Requirements 11.7, 12.3, 12.4, 12.8, 12.9.
 *
 * A thin sibling of `RunesTab`: identical participant ordering and grouping
 * (the same `groupParticipantsByTeam` call), reading `MatchParticipant.augments`
 * instead of `.runes`. Mayhem participants have no meaningful rune page — that
 * data is still captured (always zero/empty for this queue) but this tab
 * never reads it.
 */

import type { MatchParticipant } from '../api/types';
import { groupParticipantsByTeam, participantKey } from '../domain/participantOrder';
import { AugmentIcon } from './AugmentIcon';
import { ChampionIcon } from './ChampionIcon';

function AugmentCard({ participant }: { participant: MatchParticipant }) {
  return (
    // Reuses RunesTab's card/identity/group classes verbatim — the markup shape
    // is identical, so a second near-duplicate stylesheet section would only be
    // two places to keep in sync for no visual difference.
    <li
      data-testid={`augment-card-${participantKey(participant)}`}
      className={participant.isAnalyzedPlayer ? 'rune-page-card rune-page-card--analyzed' : 'rune-page-card'}
    >
      <div className="rune-page-identity">
        <ChampionIcon championKey={participant.championName} size={32} />
        {participant.isAnalyzedPlayer ? <span className="you-badge">You</span> : null}
      </div>
      {/*
       * Requirement 12.9: a participant with fewer than six captured augments
       * renders exactly that many icons — an empty slot for "not yet picked"
       * is not the same situation as `RunesTab`'s "unavailable" state, so no
       * unavailable message is shown here, ever.
       */}
      <div className="rune-group">
        {participant.augments.map((augmentId, index) => (
          // Requirement 12.1: Riot's reported field order (playerAugment1..6), never sorted.
          <AugmentIcon key={index} augmentId={augmentId} size={20} />
        ))}
      </div>
    </li>
  );
}

export interface AugmentsTabProps {
  participants: readonly MatchParticipant[];
}

export function AugmentsTab({ participants }: AugmentsTabProps) {
  const teams = groupParticipantsByTeam(participants);

  return (
    <div className="augments-tab" data-testid="augments-tab">
      {teams.map((team) => (
        <section key={team.teamId} aria-label={team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}>
          <h4 className={team.isAnalyzedTeam ? 'rune-team-heading' : 'rune-team-heading rune-team-heading--enemy'}>
            {team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}
          </h4>
          <ul className="rune-page-list" role="list">
            {team.participants.map((participant) => (
              <AugmentCard key={participantKey(participant)} participant={participant} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
