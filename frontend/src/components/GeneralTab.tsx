/**
 * The full ten-player scoreboard — the Detail_Panel's default tab.
 *
 * `match-detail-tabs` task 6.2 — Requirements 3.1-3.8, 8.5, 8.6.
 *
 * Ordering is delegated entirely to `groupParticipantsByTeam` (`domain/participantOrder.ts`),
 * shared verbatim with `RunesTab`, so the two tabs cannot silently disagree on
 * which ten players are shown or in what order (Requirement 3.8/4.1).
 */

import type { MatchParticipant } from '../api/types';
import { groupParticipantsByTeam, participantKey } from '../domain/participantOrder';
import { ChampionIcon } from './ChampionIcon';
import { ItemBuildRow } from './ItemBuildRow';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { SummonerSpellIcon } from './SummonerSpellIcon';

function formatKda3(kills: number, deaths: number, assists: number): string {
  return `${String(kills)}/${String(deaths)}/${String(assists)}`;
}

function formatKillParticipation(percent: number | 'N/A'): string {
  return percent === 'N/A' ? 'N/A' : `${String(percent)}%`;
}

function ScoreboardRow({ participant }: { participant: MatchParticipant }) {
  const keystoneId = participant.runes.primarySelections[0] ?? 0;

  return (
    <tr
      data-testid={`scoreboard-row-${participantKey(participant)}`}
      // Requirement 3.7: distinguished by more than colour — the row header text
      // itself names the analyzed player, independent of the CSS class below.
      className={participant.isAnalyzedPlayer ? 'scoreboard-row scoreboard-row--analyzed' : 'scoreboard-row'}
    >
      <th scope="row" className="scoreboard-identity">
        {participant.riotIdGameName}
        <span className="scoreboard-tagline">#{participant.riotIdTagline}</span>
        {participant.isAnalyzedPlayer ? <span className="you-badge">You</span> : null}
      </th>
      <td className="champion-col">
        <ChampionIcon championKey={participant.championName} size={32} className="scoreboard-champion-icon" />
        <span className="scoreboard-level">Lv {participant.champLevel}</span>
      </td>
      <td className="scoreboard-loadout">
        <SummonerSpellIcon spellId={participant.summonerSpells[0]} size={16} />
        <SummonerSpellIcon spellId={participant.summonerSpells[1]} size={16} />
        <RuneIcon runeId={keystoneId} size={16} />
        <RuneTreeIcon
          styleId={participant.runes.secondaryStyle}
          size={16}
          selectionIds={participant.runes.secondarySelections}
        />
      </td>
      <td>
        <ItemBuildRow build={participant.build} size={20} />
      </td>
      <td>{formatKda3(participant.kills, participant.deaths, participant.assists)}</td>
      <td>{participant.cs}</td>
      <td>{participant.visionScore}</td>
      <td>{participant.damageToChampions}</td>
      <td>{participant.goldEarned}</td>
      <td>{formatKillParticipation(participant.killParticipationPercent)}</td>
    </tr>
  );
}

export interface GeneralTabProps {
  participants: readonly MatchParticipant[];
}

export function GeneralTab({ participants }: GeneralTabProps) {
  const teams = groupParticipantsByTeam(participants);

  return (
    <div className="general-tab" data-testid="general-tab">
      {teams.map((team) => (
        <div className="table-scroll" key={team.teamId}>
          <table className="data-table scoreboard-table">
            <caption className={team.isAnalyzedTeam ? 'scoreboard-team-heading' : 'scoreboard-team-heading scoreboard-team-heading--enemy'}>
              {team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="champion-col">Champion</th>
                <th scope="col">Loadout</th>
                <th scope="col">Build</th>
                <th scope="col">K/D/A</th>
                <th scope="col">CS</th>
                <th scope="col">Vision</th>
                <th scope="col">Damage</th>
                <th scope="col">Gold</th>
                <th scope="col">Kill %</th>
              </tr>
            </thead>
            {/* Requirement 8.6: standard table row/header association is what ties
                each cell to its Participant for assistive technology — no extra
                aria wiring needed beyond `scope="row"` on the identifying cell. */}
            <tbody>
              {team.participants.map((participant) => (
                <ScoreboardRow key={participantKey(participant)} participant={participant} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
