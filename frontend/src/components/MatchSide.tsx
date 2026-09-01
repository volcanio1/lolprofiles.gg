/**
 * One side of a mirrored `MatchRow` — the analyzed player's or the Enemy_Laner's
 * champion, loadout, line stats, and Final_Build.
 *
 * `match-detail-tabs` task 5.1 — Requirements 1.1, 1.2, 1.3, 1.4.
 *
 * ---------------------------------------------------------------------------
 * LAYOUT: A HORIZONTAL BAND, NOT A STACK
 * ---------------------------------------------------------------------------
 *
 * Four blocks read left to right (and right to left on the opponent's side, so
 * the two mirror around the divider): portrait + loadout, identity + line stats,
 * the Final_Build, and the LP Score. Each block is close to its natural width,
 * so the whole side fits ~400px and two of them sit side by side inside the
 * report's main column without wrapping — the stacked version this replaced
 * needed roughly twice the height and still overflowed once the summary rail
 * took its share of the page.
 *
 * The three line stats are a label/value grid rather than three side-by-side
 * columns for the same reason: same information, about a third of the width,
 * and it lines up with the portrait block's height.
 *
 * ---------------------------------------------------------------------------
 * "PRIMARY AND SECONDARY RUNE" IS KEYSTONE PLUS SECONDARY TREE
 * ---------------------------------------------------------------------------
 *
 * design.md decision 6: the primary tree is already implied by its keystone (a
 * keystone belongs to exactly one tree), so showing the primary tree icon beside
 * the keystone would spend a slot restating something the keystone already says.
 * Keystone plus secondary tree carries strictly more information in the same
 * space — the full Rune_Page, including both tree identifiers, is on the Runes
 * tab (task 6.3), so nothing here is lost, only deferred.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COMPONENT NEVER RECEIVES A NULL BUILD OR A MISSING CHAMPION
 * ---------------------------------------------------------------------------
 *
 * Requirement 1.7 says the ENTIRE opposing side is replaced by the no-opponent
 * notice when no Enemy_Laner was identified — not that this component degrades
 * field-by-field. `MatchRow` therefore only renders a `MatchSide` when it has a
 * concrete `championName` and `build` to give it (the analyzed player's own, or
 * `match.opponent`'s). `summonerSpells`/`runes` are the one case that CAN be
 * absent even when the side itself is rendered — Riot capturing fewer than ten
 * participants for a match (Requirement 6.11) can leave `match.participants`
 * without a marked row — so `MatchRow` passes a neutral empty loadout in that
 * case, which resolves through the existing icon components to placeholders
 * exactly the way an unresolvable identifier already does.
 */

import type { ItemBuild, RunePage } from '../api/types';
import type { MatchRating } from '../domain/matchRating';
import { ChampionIcon } from './ChampionIcon';
import { ItemBuildRow } from './ItemBuildRow';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { SummonerSpellIcon } from './SummonerSpellIcon';

/** All zero — resolves to placeholders throughout, the same as any unresolvable identifier. */
export const EMPTY_RUNE_PAGE: RunePage = {
  primaryStyle: 0,
  secondaryStyle: 0,
  primarySelections: [],
  secondarySelections: [],
  statShards: [0, 0, 0],
};

function formatKda3(kills: number, deaths: number, assists: number): string {
  return `${String(kills)}/${String(deaths)}/${String(assists)}`;
}

/** CS/min with the raw CS count in brackets, e.g. `5.6(124)` — matches the existing convention. */
function formatCsPerMinute(csPerMinute: number, cs: number): string {
  const rate = Number.isFinite(csPerMinute) ? csPerMinute.toFixed(1) : '0.0';
  const raw = Number.isInteger(cs) ? String(cs) : cs.toFixed(2);
  return `${rate}(${raw})`;
}

export interface MatchSideProps {
  side: 'player' | 'opponent';
  /** '' when no marked participant row supplied one (Requirement 6.11) — the name line is omitted. */
  riotIdGameName: string;
  riotIdTagline: string;
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMinute: number;
  visionScore: number;
  build: ItemBuild;
  /** `[0, 0]` when no marked participant row supplied one — resolves to placeholders. */
  summonerSpells: readonly [number, number];
  runes: RunePage;
  /** This laner's LP Score; `null` when no marked participant row exists to rate. */
  rating: MatchRating | null;
}

export function MatchSide({
  side,
  riotIdGameName,
  riotIdTagline,
  championName,
  kills,
  deaths,
  assists,
  cs,
  csPerMinute,
  visionScore,
  build,
  summonerSpells,
  runes,
  rating,
}: MatchSideProps) {
  const label = side === 'player' ? 'You' : 'Opponent';
  // Requirement 4.5: preserve Riot's reported slot order — the keystone is
  // whichever rune Riot reported first in the primary tree, not necessarily
  // "the strongest" or any other derived notion.
  const keystoneId = runes.primarySelections[0] ?? 0;

  return (
    <div className={`match-side match-side--${side}`} data-testid={`match-side-${side}`}>
      <span className="sr-only">{label}</span>

      {/* Portrait (with the champion's name beneath it) and the four loadout
          icons, as one fixed-width block at the outer edge of the side. */}
      <div className="match-side-portrait">
        <ChampionIcon championKey={championName} size={44} className="match-side-champion-icon" />
        <div className="match-side-loadout">
          <SummonerSpellIcon spellId={summonerSpells[0]} size={18} className="match-side-spell-icon" />
          <SummonerSpellIcon spellId={summonerSpells[1]} size={18} className="match-side-spell-icon" />
          <RuneIcon runeId={keystoneId} size={18} className="match-side-rune-icon" />
          <RuneTreeIcon
            styleId={runes.secondaryStyle}
            size={18}
            className="match-side-rune-tree-icon"
            selectionIds={runes.secondarySelections}
          />
        </div>
      </div>

      {/* Who they are, then the three line stats as a compact label/value grid. */}
      <div className="match-side-figures">
        {riotIdGameName.length > 0 ? (
          <p className="match-side-name">
            {riotIdGameName}
            <span className="match-side-tagline">#{riotIdTagline}</span>
          </p>
        ) : null}
        {/* Abbreviated terms: this grid sits between the portrait and the build
            in a ~400px band, and the full words ("K/D/A", "CS/min", "Vision")
            set the label column ~40% wider than the figures need. The scoreboard
            in the expanded panel already abbreviates the same three the same
            way, so the two read consistently. */}
        <dl className="match-side-stats">
          <div className="match-side-stat">
            <dt>KDA</dt>
            <dd>{formatKda3(kills, deaths, assists)}</dd>
          </div>
          <div className="match-side-stat">
            <dt>CS/m</dt>
            <dd>{formatCsPerMinute(csPerMinute, cs)}</dd>
          </div>
          <div className="match-side-stat">
            <dt>Vis</dt>
            <dd>{visionScore}</dd>
          </div>
        </dl>
      </div>

      <ItemBuildRow build={build} size={20} className="match-side-build" />

      {rating ? (
        <div
          className={`lp-score lp-score--${rating.tier}`}
          data-testid={`lp-score-${side}`}
          title="Score — overall match performance, 0 to 100"
        >
          <span className="lp-score-value">{rating.score}</span>
          {/* The full scale is in the `title`; the expanded panel's scoreboard
              heads the same figure under the same "Score". */}
          <span className="lp-score-label">Score</span>
        </div>
      ) : null}
    </div>
  );
}
