/**
 * One headline champion build — "Most popular" or "Highest win rate"
 * (champion-build-stats Requirement 5.2/5.3).
 *
 * A win/pick-rate summary, then — in reading order — the rune page, the skill
 * order, and finally the item build (starting items, core build, summoner
 * spells) grouped together, through the same components the match detail views
 * use. Each section shows how many games in this build's cohort back its modal
 * value ("N games"), mirroring the reference build layout. A section the backend
 * could not fill (a `null` field below the modal threshold) shows a small "not
 * enough data" line in place of just that section — the panel never hides
 * wholesale (Requirement 7.3). No figure renders as `NaN` / `Infinity%`
 * (Requirement 5.5).
 */

import type { ChampionBuild } from '../api/types';
import { formatGameCount, formatRateToPercent } from '../domain/format';
import { ItemSlot } from './ItemBuildRow';
import { CoreItemsRow } from './CoreItemsRow';
import { RunePageCard } from './RunePageCard';
import { SkillOrderChart } from './SkillOrderView';
import { SummonerSpellIcon } from './SummonerSpellIcon';

export interface ChampionBuildPanelProps {
  /** "Most popular" / "Highest win rate" — also the panel's accessible name. */
  label: string;
  championKey: string;
  build: ChampionBuild;
  /** Optional line under the label, e.g. the Requirement 5.4 same-build note. */
  note?: string;
}

function Missing() {
  return <p className="champion-build-missing">Not enough data yet.</p>;
}

/** "N games" under a section, from the modal value's cohort count. Hidden when
 * the backend did not report a count (legacy / empty). */
function GamesTag({ games }: { games: number }) {
  if (!Number.isFinite(games) || games <= 0) {
    return null;
  }
  return <span className="champion-build-games">{formatGameCount(games)} games</span>;
}

/** A win/pick rate as a gold arc on a dark track with the figure in the centre
 * (design-system: gold = the highlighted figure, never a green/red WR tint). */
function RadialStat({ label, value, testId }: { label: string; value: number; testId: string }) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const text = formatRateToPercent(value);
  return (
    <div className="champion-build-radial">
      <svg viewBox="0 0 56 56" className="champion-build-radial-svg" role="img" aria-label={`${label}: ${text}`}>
        <circle cx="28" cy="28" r={radius} className="champion-build-radial-track" />
        <circle
          cx="28"
          cy="28"
          r={radius}
          className="champion-build-radial-arc"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
          transform="rotate(-90 28 28)"
        />
        <text x="28" y="28" className="champion-build-radial-value" data-testid={testId}>
          {text}
        </text>
      </svg>
      <span className="champion-build-radial-label">{label}</span>
    </div>
  );
}

export function ChampionBuildPanel({ label, championKey, build, note }: ChampionBuildPanelProps) {
  return (
    <section className="champion-build-panel" aria-label={label}>
      <header className="champion-build-panel-head">
        <h3 className="champion-build-panel-label">{label}</h3>
        {note !== undefined ? <p className="champion-build-panel-note">{note}</p> : null}
        <div className="champion-build-panel-stats">
          <RadialStat label="Win rate" value={build.winRate} testId="build-win-rate" />
          <RadialStat label="Pick rate" value={build.pickRate} testId="build-pick-rate" />
          <div className="champion-build-panel-count">
            <span className="champion-build-panel-count-value" data-testid="build-match-count">
              {formatGameCount(build.matchCount)} games
            </span>
            <span className="champion-build-panel-count-label">Games on this build</span>
          </div>
        </div>
      </header>

      <div className="champion-build-section">
        <div className="champion-build-section-head">
          <h4 className="champion-build-section-heading">Runes</h4>
          {build.runes !== null ? <GamesTag games={build.runes.games} /> : null}
        </div>
        <ul className="champion-build-runes" role="list">
          <RunePageCard
            runes={build.runes?.value ?? null}
            championKey={championKey}
            testId="champion-build-runes"
            unavailableText="Not enough data for a rune page yet."
          />
        </ul>
      </div>

      <div className="champion-build-section">
        {build.skillOrder !== null ? (
          <>
            <div className="champion-build-section-head">
              <h4 className="champion-build-section-heading">Skill order</h4>
              <GamesTag games={build.skillOrder.games} />
            </div>
            <SkillOrderChart
              championKey={championKey}
              perLevel={build.skillOrder.value.perLevel}
              maxOrder={build.skillOrder.value.maxOrder}
              hideHeading
            />
          </>
        ) : (
          <>
            <h4 className="champion-build-section-heading">Skill order</h4>
            <Missing />
          </>
        )}
      </div>

      <div className="champion-build-section champion-build-combo">
        <div>
          <div className="champion-build-section-head">
            <h4 className="champion-build-section-heading">Starting items</h4>
            {build.startingItems !== null ? <GamesTag games={build.startingItems.games} /> : null}
          </div>
          {build.startingItems !== null && build.startingItems.value.length > 0 ? (
            <div className="champion-build-starting" data-testid="build-starting-items">
              {build.startingItems.value.map((id, index) => (
                <ItemSlot key={index} id={id} size={28} className="core-items-icon" />
              ))}
            </div>
          ) : (
            <Missing />
          )}
        </div>

        <div>
          <h4 className="champion-build-section-heading">Core build</h4>
          {build.coreItems.length > 0 ? <CoreItemsRow slots={build.coreItems} /> : <Missing />}
        </div>

        <div>
          <div className="champion-build-section-head">
            <h4 className="champion-build-section-heading">Summoner spells</h4>
            {build.summonerSpells !== null ? <GamesTag games={build.summonerSpells.games} /> : null}
          </div>
          {build.summonerSpells !== null ? (
            <div className="champion-build-spells" data-testid="build-spells">
              <SummonerSpellIcon spellId={build.summonerSpells.value[0]} size={28} />
              <SummonerSpellIcon spellId={build.summonerSpells.value[1]} size={28} />
            </div>
          ) : (
            <Missing />
          )}
        </div>
      </div>
    </section>
  );
}
