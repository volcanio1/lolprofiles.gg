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
import { groupParticipantsByTeam, isRunePageUnavailable, participantKey } from '../domain/participantOrder';
import { ChampionIcon } from './ChampionIcon';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { StatShardIcon } from './StatShardIcon';

function RunePageCard({ participant }: { participant: MatchParticipant }) {
  const { runes } = participant;

  return (
    <li
      data-testid={`rune-page-${participantKey(participant)}`}
      className={participant.isAnalyzedPlayer ? 'rune-page-card rune-page-card--analyzed' : 'rune-page-card'}
    >
      <div className="rune-page-identity">
        <ChampionIcon championKey={participant.championName} size={32} />
        {participant.isAnalyzedPlayer ? <span className="you-badge">You</span> : null}
      </div>

      {isRunePageUnavailable(runes) ? (
        <p data-testid={`rune-page-${participantKey(participant)}-unavailable`} className="rune-page-unavailable">
          Rune page unavailable.
        </p>
      ) : (
        <>
          {/* Requirement 4.4: three visually distinguishable groups. */}
          <div className="rune-group rune-group--primary">
            <RuneTreeIcon styleId={runes.primaryStyle} size={20} className="rune-group-tree-icon" />
            {runes.primarySelections.map((runeId, index) => (
              // Requirement 4.5: Riot's reported slot order, never sorted or deduped.
              <RuneIcon key={index} runeId={runeId} size={16} />
            ))}
          </div>
          <div className="rune-group rune-group--secondary">
            <RuneTreeIcon styleId={runes.secondaryStyle} size={20} className="rune-group-tree-icon" />
            {runes.secondarySelections.map((runeId, index) => (
              <RuneIcon key={index} runeId={runeId} size={16} />
            ))}
          </div>
          <div className="rune-group rune-group--shards">
            {runes.statShards.map((shardId, index) => (
              <StatShardIcon key={index} shardId={shardId} size={16} />
            ))}
          </div>
        </>
      )}
    </li>
  );
}

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
              <RunePageCard key={participantKey(participant)} participant={participant} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
