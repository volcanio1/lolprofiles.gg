/**
 * clash-scouting Requirement 1.5: a player registered to more than one Clash
 * team, with no `teamId` supplied yet, picks which one to scout.
 *
 * Text-only: `ClashTeamSummary.iconId` addresses Riot's Clash team-icon set,
 * which the Static_Data_Provider has no accessor for (only summoner profile
 * icons and champion/rune/spell assets are resolved today) — rendering it
 * through `profileIconUrl` would show the wrong image, so name + abbreviation
 * carry the picker instead.
 */

import type { ClashTeamSummary } from '../api/types';

export interface ClashTeamPickerProps {
  teams: readonly ClashTeamSummary[];
  onSelect: (teamId: string) => void;
}

export function ClashTeamPicker({ teams, onSelect }: ClashTeamPickerProps) {
  return (
    <section aria-label="Choose a Clash team to scout" data-testid="clash-team-picker" className="clash-team-picker">
      <p className="clash-team-picker-prompt">This player is registered to more than one Clash team.</p>
      <ul className="clash-team-picker-list">
        {teams.map((team) => (
          <li key={team.id}>
            <button
              type="button"
              className="clash-team-picker-option"
              data-testid="clash-team-option"
              onClick={() => onSelect(team.id)}
            >
              <span className="clash-team-picker-name">{team.name}</span>
              <span className="clash-team-picker-abbr">{team.abbreviation}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
