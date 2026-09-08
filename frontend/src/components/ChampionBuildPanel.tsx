/**
 * One headline champion build — "Most popular" or "Highest win rate"
 * (champion-build-stats Requirement 5.2/5.3).
 *
 * Renders that build's win / pick rate and exact game count, then its core item
 * path, skill order, rune page and summoner spells through the same components
 * the match detail views use. Each sub-section that the backend could not fill
 * (a `null` field below the modal threshold) shows a small "not enough data"
 * line in place of just that section — the panel never hides wholesale
 * (Requirement 7.3). No figure renders as `NaN` / `Infinity%` (Requirement 5.5).
 */

import type { ChampionBuild } from '../api/types';
import { formatGameCount, formatRateToPercent } from '../domain/format';
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

export function ChampionBuildPanel({ label, championKey, build, note }: ChampionBuildPanelProps) {
  return (
    <section className="champion-build-panel" aria-label={label}>
      <header className="champion-build-panel-head">
        <h3 className="champion-build-panel-label">{label}</h3>
        {note !== undefined ? <p className="champion-build-panel-note">{note}</p> : null}
        <dl className="champion-build-panel-stats">
          <div>
            <dt>Win rate</dt>
            <dd data-testid="build-win-rate">{formatRateToPercent(build.winRate)}</dd>
          </div>
          <div>
            <dt>Pick rate</dt>
            <dd data-testid="build-pick-rate">{formatRateToPercent(build.pickRate)}</dd>
          </div>
          <div>
            <dt>Games on this build</dt>
            <dd data-testid="build-match-count">{formatGameCount(build.matchCount)} games</dd>
          </div>
        </dl>
      </header>

      <div className="champion-build-section">
        <h4 className="champion-build-section-heading">Core items</h4>
        {build.coreItems.length > 0 ? <CoreItemsRow itemIds={build.coreItems} /> : <Missing />}
      </div>

      <div className="champion-build-section">
        {build.skillOrder !== null ? (
          <SkillOrderChart
            championKey={championKey}
            perLevel={build.skillOrder.perLevel}
            maxOrder={build.skillOrder.maxOrder}
          />
        ) : (
          <>
            <h4 className="champion-build-section-heading">Skill order</h4>
            <Missing />
          </>
        )}
      </div>

      <div className="champion-build-section">
        <h4 className="champion-build-section-heading">Runes</h4>
        <ul className="champion-build-runes" role="list">
          <RunePageCard
            runes={build.runes}
            championKey={championKey}
            testId="champion-build-runes"
            unavailableText="Not enough data for a rune page yet."
          />
        </ul>
      </div>

      <div className="champion-build-section">
        <h4 className="champion-build-section-heading">Summoner spells</h4>
        {build.summonerSpells !== null ? (
          <div className="champion-build-spells" data-testid="build-spells">
            <SummonerSpellIcon spellId={build.summonerSpells[0]} size={28} />
            <SummonerSpellIcon spellId={build.summonerSpells[1]} size={28} />
          </div>
        ) : (
          <Missing />
        )}
      </div>
    </section>
  );
}
