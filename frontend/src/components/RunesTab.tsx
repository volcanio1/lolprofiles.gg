/**
 * All ten players' champions and complete rune pages.
 *
 * `match-detail-tabs` task 6.3 — Requirements 4.1-4.5, 9.2.
 *
 * Ordering and grouping are the exact same `groupParticipantsByTeam` call
 * `GeneralTab` makes (Requirement 4.1) — the two tabs cannot disagree because
 * neither computes its own order.
 */

import type { MatchParticipant } from '../api/types';
import { groupParticipantsByTeam, participantKey } from '../domain/participantOrder';
import { RunePageCard } from './RunePageCard';

export interface RunesTabProps {
  participants: readonly MatchParticipant[];
}

export function RunesTab({ participants }: RunesTabProps) {
  const teams = groupParticipantsByTeam(participants);

  return (
    <div className="runes-tab" data-testid="runes-tab">
      {teams.map((team) => (
        <section key={team.teamId} aria-label={team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}>
          <h4 className={team.isAnalyzedTeam ? 'rune-team-heading' : 'rune-team-heading rune-team-heading--enemy'}>
            {team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}
          </h4>
          <ul className="rune-page-list" role="list">
            {team.participants.map((participant) => (
              <RunePageCard
                key={participantKey(participant)}
                runes={participant.runes}
                championKey={participant.championName}
                variant={participant.isAnalyzedPlayer ? 'analyzed' : 'default'}
                testId={`rune-page-${participantKey(participant)}`}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
