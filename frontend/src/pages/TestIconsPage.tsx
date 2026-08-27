/**
 * Manual inspection page (`/test`) — not linked from anywhere.
 *
 * Renders every stat name we parse from Data Dragon next to its resolved
 * `StatIcon`, plus a handful of live asset tooltips, so the icon coverage and
 * the parsed descriptions can be eyeballed (and screenshotted) without walking
 * through a real profile lookup.
 */

import { useStaticData } from '../staticData';
import { StatIcon, statIconKey } from '../components/StatIcon';
import { Tooltip } from '../components/Tooltip';
import { ItemBuildRow } from '../components/ItemBuildRow';
import { SummonerSpellIcon } from '../components/SummonerSpellIcon';
import { RuneIcon } from '../components/RuneIcon';
import { RuneTreeIcon } from '../components/RuneTreeIcon';
import type { AssetDescription } from '../staticData/provider';

/** The full set of `<stats>` names observed across Data Dragon `item.json` (16.17.1). */
const ALL_ITEM_STATS = [
  'Ability Haste',
  'Ability Power',
  'Adaptive Force',
  'Armor',
  'Armor Penetration',
  'Attack Damage',
  'Attack Speed',
  'Base Health Regen',
  'Base Mana Regen',
  'Cooldown Reduction',
  'Critical Strike Chance',
  'Critical Strike Damage',
  'Gold Per 10 Seconds',
  'Heal and Shield Power',
  'Health',
  'Health Regen per 5 seconds',
  'Lethality',
  'Life Steal',
  'Magic Penetration',
  'Magic Resist',
  'Mana',
  'Mana Regen per 5 seconds',
  'Move Speed',
  'Omnivamp',
  'Tenacity',
  'Cooldown', // synthetic — summoner spell tooltips only
];

/** Representative ids for live tooltips. */
const SAMPLE_ITEMS = [
  { id: 3031, label: 'Infinity Edge (stats only, no passive)' },
  { id: 3153, label: "Blade of the Ruined King (stats + 2 passives)" },
  { id: 6695, label: "Serylda's Grudge / Youmuu's-family (lethality)" },
  { id: 3157, label: "Zhonya's Hourglass (active)" },
  { id: 3340, label: 'Stealth Ward (trinket, active only)' },
];
const SAMPLE_SPELLS = [4, 14, 12, 7]; // Flash, Ignite, Teleport, Heal
const SAMPLE_RUNES = [8112, 8005, 8021]; // Electrocute, Press the Attack, Fleet Footwork
const SAMPLE_SECONDARY = { treeId: 8000, selections: [9111, 8014] }; // Precision: Presence of Mind, Coup de Grace

function DescriptionBlock({ description }: { description: AssetDescription }) {
  return (
    <div className="tooltip-bubble" style={{ position: 'static', maxHeight: 'none', pointerEvents: 'auto' }}>
      {description.stats.length > 0 ? (
        <span className="tooltip-stats">
          {description.stats.map((line, i) => (
            <span className="tooltip-stat-row" key={i}>
              <span className="tooltip-stat-icon-slot">
                <StatIcon stat={line.stat} className="tooltip-stat-icon" />
              </span>
              {line.amount ? <span className="tooltip-stat-amount">{line.amount}</span> : null}
              <span className="tooltip-stat-name">{line.stat}</span>
            </span>
          ))}
        </span>
      ) : null}
      {description.paragraphs.length > 0 ? (
        <span className="tooltip-body">
          {description.paragraphs.map((p, i) => (
            <span className="tooltip-para" key={i}>
              {p}
            </span>
          ))}
        </span>
      ) : (
        <em style={{ color: 'var(--dim)' }}>no description</em>
      )}
    </div>
  );
}

export function TestIconsPage() {
  const provider = useStaticData();

  return (
    <div className="report" style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <h2 className="rsec-title">Stat icon coverage — {provider.version ?? 'loading…'}</h2>
      <p className="lede">
        Bundled League of Legends Wiki stat-icon set (Riot&rsquo;s in-game glyphs;
        <code>src/assets/stat-icons/</code>, inlined into the bundle). &ldquo;Cooldown&rdquo; uses
        Riot&rsquo;s client clock glyph. Anything still showing &ldquo;text only&rdquo; has no mapping.
      </p>
      <table className="data-table" style={{ marginBottom: '2.5rem' }}>
        <thead>
          <tr>
            <th scope="col">Stat</th>
            <th scope="col">Icon</th>
            <th scope="col">Key</th>
          </tr>
        </thead>
        <tbody>
          {ALL_ITEM_STATS.map((stat) => {
            const key = stat === 'Cooldown' ? 'cooldown (inline clock svg)' : statIconKey(stat);
            return (
              <tr key={stat}>
                <th scope="row">{stat}</th>
                <td>
                  <span className="tooltip-stat-icon-slot" style={{ width: 20, height: 20 }}>
                    <StatIcon stat={stat} size={20} />
                  </span>
                </td>
                <td style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                  {key !== '' ? key : <span style={{ color: 'var(--dim)' }}>text only — no mapping</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="rsec-title">Item descriptions</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {SAMPLE_ITEMS.map(({ id, label }) => (
          <div key={id} style={{ width: 320 }}>
            <p style={{ fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--dim)' }}>
              {id} — {label}
            </p>
            <Tooltip title={provider.itemDisplayName(id)} description={provider.itemDescription(id)}>
              <ItemBuildRow build={{ items: [id, 0, 0, 0, 0, 0], trinket: 0 }} size={28} />
            </Tooltip>
            <DescriptionBlock description={provider.itemDescription(id)} />
          </div>
        ))}
      </div>

      <h2 className="rsec-title">Summoner spells (with cooldown)</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {SAMPLE_SPELLS.map((id) => (
          <div key={id} style={{ width: 260 }}>
            <p style={{ fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--dim)' }}>
              {id} — {provider.summonerSpellDisplayName(id)}
            </p>
            <SummonerSpellIcon spellId={id} size={28} />
            <DescriptionBlock description={provider.summonerSpellDescription(id)} />
          </div>
        ))}
      </div>

      <h2 className="rsec-title">Runes</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2.5rem' }}>
        {SAMPLE_RUNES.map((id) => (
          <div key={id} style={{ width: 300 }}>
            <p style={{ fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--dim)' }}>
              {id} — {provider.runeDisplayName(id)}
            </p>
            <RuneIcon runeId={id} size={28} />
            <DescriptionBlock description={provider.runeDescription(id)} />
          </div>
        ))}
      </div>

      <h2 className="rsec-title">Secondary rune tree (hover-expands to picks)</h2>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        <RuneTreeIcon
          styleId={SAMPLE_SECONDARY.treeId}
          size={28}
          selectionIds={SAMPLE_SECONDARY.selections}
        />
        <span style={{ fontSize: '0.8rem', color: 'var(--dim)' }}>
          hover the tree icon — {SAMPLE_SECONDARY.selections.map((r) => provider.runeDisplayName(r)).join(', ')}
        </span>
      </div>
    </div>
  );
}
