/**
 * The full ten-player scoreboard — the Detail_Panel's default tab.
 *
 * `match-detail-tabs` task 6.2 — Requirements 3.1-3.8, 8.5, 8.6.
 *
 * Ordering is delegated entirely to `groupParticipantsByTeam` (`domain/participantOrder.ts`),
 * shared verbatim with `RunesTab`, so the two tabs cannot silently disagree on
 * which ten players are shown or in what order (Requirement 3.8/4.1).
 *
 * Layout (revised 2026-08-27): the champion column is the portrait, then the
 * champion's name with `Lv N` on a line under that name — the name comes from
 * `ChampionIcon` itself (it renders portrait + name), so this file must NOT add
 * a second name, which is how it ended up duplicated once already. The player
 * name + full tag is its own headerless column, set apart to the right. A long
 * player name wraps within its column, and every row is a fixed 3rem tall so one
 * wrapped name doesn't leave its row taller than the rest.
 * Spells and runes share one unlabelled column; the damage cell carries a bar
 * scaled to the match's highest damage; each row ends with a colour-coded
 * performance rating. Header and cell alignment match per column.
 */

import type { MatchParticipant } from '../api/types';
import { computeMatchRating } from '../domain/matchRating';
import { groupParticipantsByTeam, participantKey } from '../domain/participantOrder';
import { ChampionIcon } from './ChampionIcon';
import { ItemBuildRow } from './ItemBuildRow';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { SummonerSpellIcon } from './SummonerSpellIcon';

function formatKda3(kills: number, deaths: number, assists: number): string {
  return `${String(kills)} / ${String(deaths)} / ${String(assists)}`;
}

function formatKillParticipation(percent: number | 'N/A'): string {
  return percent === 'N/A' ? '—' : `${String(percent)}%`;
}

/** `24138 -> "24.1k"`, `950 -> "950"`. Keeps the damage/gold columns narrow. */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  if (Math.abs(value) < 1000) {
    return String(Math.round(value));
  }
  const thousands = value / 1000;
  return `${thousands.toFixed(thousands < 100 ? 1 : 0)}k`;
}

function ScoreboardRow({
  participant,
  allParticipants,
  maxDamage,
  durationSeconds,
}: {
  participant: MatchParticipant;
  allParticipants: readonly MatchParticipant[];
  maxDamage: number;
  durationSeconds: number;
}) {
  const keystoneId = participant.runes.primarySelections[0] ?? 0;
  const damagePercent = maxDamage > 0 ? Math.round((participant.damageToChampions / maxDamage) * 100) : 0;
  const rating = computeMatchRating(participant, allParticipants, durationSeconds);

  return (
    <tr
      data-testid={`scoreboard-row-${participantKey(participant)}`}
      // Requirement 3.7: distinguished by more than colour — the row header text
      // itself names the analyzed player, independent of the CSS class below.
      className={participant.isAnalyzedPlayer ? 'scoreboard-row scoreboard-row--analyzed' : 'scoreboard-row'}
    >
      <td className="sb-champ">
        <span className="sb-champ-inner">
          <ChampionIcon championKey={participant.championName} size={32} className="sb-champion-icon" />
          <span className="sb-level">Lv {participant.champLevel}</span>
        </span>
      </td>

      <th
        scope="row"
        className="sb-player"
        title={`${participant.riotIdGameName}#${participant.riotIdTagline}`}
      >
        <span className="sb-name-line">
          <span className="sb-name">{participant.riotIdGameName}</span>
          <span className="sb-tag">#{participant.riotIdTagline}</span>
          {participant.isAnalyzedPlayer ? <span className="you-badge">You</span> : null}
        </span>
      </th>

      <td className="sb-loadout">
        <span className="sb-loadout-inner">
          <span className="sb-loadout-col">
            <SummonerSpellIcon spellId={participant.summonerSpells[0]} size={16} />
            <SummonerSpellIcon spellId={participant.summonerSpells[1]} size={16} />
          </span>
          <span className="sb-loadout-col">
            <RuneIcon runeId={keystoneId} size={16} />
            <RuneTreeIcon
              styleId={participant.runes.secondaryStyle}
              size={16}
              selectionIds={participant.runes.secondarySelections}
            />
          </span>
        </span>
      </td>

      <td className="sb-build">
        <ItemBuildRow build={participant.build} size={22} />
      </td>

      <td className="sb-num sb-kda">{formatKda3(participant.kills, participant.deaths, participant.assists)}</td>
      <td className="sb-num">{participant.cs}</td>
      <td className="sb-num sb-damage">
        <span className="sb-damage-value">{formatCompactNumber(participant.damageToChampions)}</span>
        <span className="sb-damage-bar" aria-hidden="true">
          <span className="sb-damage-bar-fill" style={{ width: `${String(damagePercent)}%` }} />
        </span>
      </td>
      <td className="sb-num">{formatKillParticipation(participant.killParticipationPercent)}</td>
      <td className="sb-num sb-rating-cell">
        <span
          className={`sb-rating sb-rating--${rating.tier}`}
          title="Score — overall match performance, 0 to 100"
        >
          {rating.score}
        </span>
      </td>
    </tr>
  );
}

export interface GeneralTabProps {
  participants: readonly MatchParticipant[];
  /** Game length, for the per-minute stats that feed the rating. */
  durationSeconds: number;
}

export function GeneralTab({ participants, durationSeconds }: GeneralTabProps) {
  const teams = groupParticipantsByTeam(participants);
  const maxDamage = participants.reduce((max, p) => Math.max(max, p.damageToChampions), 0);

  return (
    <div className="general-tab" data-testid="general-tab">
      {teams.map((team) => (
        <div className="table-scroll" key={team.teamId}>
          <table className="scoreboard-table">
            <caption
              className={
                team.isAnalyzedTeam ? 'scoreboard-team-heading' : 'scoreboard-team-heading scoreboard-team-heading--enemy'
              }
            >
              {team.isAnalyzedTeam ? 'Your team' : 'Enemy team'}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sb-champ" aria-label="Champion and level" />
                <th scope="col" className="sb-player" aria-label="Player" />
                <th scope="col" className="sb-loadout" aria-label="Summoner spells and runes" />
                <th scope="col" className="sb-build">Build</th>
                <th scope="col" className="sb-num">KDA</th>
                <th scope="col" className="sb-num">CS</th>
                <th scope="col" className="sb-num">Dmg</th>
                <th scope="col" className="sb-num">KP</th>
                <th scope="col" className="sb-num">Score</th>
              </tr>
            </thead>
            {/* Requirement 8.6: standard table row/header association is what ties
                each cell to its Participant for assistive technology. */}
            <tbody>
              {team.participants.map((participant) => (
                <ScoreboardRow
                  key={participantKey(participant)}
                  participant={participant}
                  allParticipants={participants}
                  maxDamage={maxDamage}
                  durationSeconds={durationSeconds}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
