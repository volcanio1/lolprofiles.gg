/**
 * The analyzed player's ability leveling order for one match.
 *
 * `item-timeline` — a sibling of `BuildPathView` in the Build Path tab.
 *
 * Two parts:
 *  - the four ability tiles (Q / W / E / R), each with the champion's spell icon
 *    and, on Q/W/E, a badge for the order it was maxed (①②③);
 *  - a grid: one row per ability, one column per level, the cell filled at the
 *    level that ability was leveled — the classic skill-order chart.
 *
 * Spell icons come from Data Dragon's per-champion file, fetched straight from
 * the CDN (like the Static Data Provider's own fetches) and module-cached. If it
 * is unavailable the tiles fall back to plain Q/W/E/R letters — the order data
 * itself never depends on the icons.
 */

import { useEffect, useState } from 'react';
import { DDRAGON_BASE, useStaticData } from '../staticData';

const SLOT_KEYS = ['Q', 'W', 'E', 'R'] as const;

interface ChampionAbilities {
  /** Spell icon URLs indexed 0..3 for Q/W/E/R; `null` when unresolved. */
  spellIconUrls: (string | null)[];
  spellNames: string[];
}

const abilitiesCache = new Map<string, Promise<ChampionAbilities | null>>();

async function loadChampionAbilities(version: string, championKey: string): Promise<ChampionAbilities | null> {
  const cacheKey = `${version}:${championKey}`;
  const existing = abilitiesCache.get(cacheKey);
  if (existing !== undefined) {
    return existing;
  }
  const promise = (async (): Promise<ChampionAbilities | null> => {
    try {
      const url = `${DDRAGON_BASE}/cdn/${encodeURIComponent(version)}/data/en_US/champion/${encodeURIComponent(championKey)}.json`;
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { data?: Record<string, { spells?: { name?: string; image?: { full?: string } }[] }> };
      const entry = body.data?.[championKey];
      const spells = Array.isArray(entry?.spells) ? entry.spells.slice(0, 4) : [];
      return {
        spellIconUrls: SLOT_KEYS.map((_, index) => {
          const full = spells[index]?.image?.full;
          return typeof full === 'string' && full.length > 0
            ? `${DDRAGON_BASE}/cdn/${encodeURIComponent(version)}/img/spell/${encodeURIComponent(full)}`
            : null;
        }),
        spellNames: SLOT_KEYS.map((key, index) => spells[index]?.name ?? `${key} ability`),
      };
    } catch {
      return null;
    }
  })();
  abilitiesCache.set(cacheKey, promise);
  return promise;
}

function useChampionAbilities(championKey: string): ChampionAbilities | null {
  const { version } = useStaticData();
  const [abilities, setAbilities] = useState<ChampionAbilities | null>(null);

  useEffect(() => {
    if (version === null || championKey.length === 0) {
      return;
    }
    let cancelled = false;
    void loadChampionAbilities(version, championKey).then((result) => {
      if (!cancelled) {
        setAbilities(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [version, championKey]);

  return abilities;
}

export type AbilitySlot = 'Q' | 'W' | 'E';

/** slot index 0-2 -> ability key. */
const RANKABLE_KEYS: readonly AbilitySlot[] = ['Q', 'W', 'E'];

/**
 * Q/W/E in the order they were maxed (reached 5 points) — e.g. `['Q', 'W', 'E']`.
 * An ability that never hit 5 is omitted; R is never ranked. This is the shape
 * the champion-build-stats wire contract (`Build.skillOrder.maxOrder`) already
 * uses, so `SkillOrderChart` takes it directly from either source.
 *
 * Renamed from `maxOrder` by champion-build-stats task 12.2 (the old name
 * collided with the `SkillOrderChart` prop) and changed from a slot->rank record
 * to this ordered key list.
 */
export function maxOrderFromSkillOrder(skillOrder: readonly number[]): AbilitySlot[] {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const maxedAtIndex: Record<number, number> = {};
  skillOrder.forEach((slot, index) => {
    if (slot < 1 || slot > 4) {
      return;
    }
    counts[slot] += 1;
    if (counts[slot] === 5 && maxedAtIndex[slot] === undefined) {
      maxedAtIndex[slot] = index;
    }
  });
  return [1, 2, 3]
    .filter((slot) => maxedAtIndex[slot] !== undefined)
    .sort((a, b) => maxedAtIndex[a] - maxedAtIndex[b])
    .map((slot) => RANKABLE_KEYS[slot - 1]);
}

const BADGE = ['①', '②', '③'];

export interface SkillOrderChartProps {
  /** Riot champion key, e.g. `Ahri` / `MonkeyKing`. */
  championKey: string;
  /** One ability slot (1-4 = Q/W/E/R) per champion level, in level order. */
  perLevel: readonly number[];
  /** Q/W/E in max order; empty when none reached 5 points. */
  maxOrder: readonly AbilitySlot[];
  /** Suppress the component's own "Skill order" heading — the caller renders one. */
  hideHeading?: boolean;
}

/**
 * The presentational core: ability tiles + max-order badges + the per-level
 * grid. Fed directly by the champion build page and, via the thin
 * `SkillOrderView` wrapper below, by the match Build Path tab.
 */
export function SkillOrderChart({
  championKey,
  perLevel,
  maxOrder,
  hideHeading = false,
}: SkillOrderChartProps) {
  const abilities = useChampionAbilities(championKey);
  const levels = perLevel.length;

  if (levels === 0) {
    return null;
  }

  return (
    <div className="skill-order" data-testid="skill-order">
      {hideHeading ? null : <h5 className="skill-order-heading">Skill order</h5>}

      <ul className="skill-order-tiles" role="list">
        {SLOT_KEYS.map((key, index) => {
          const iconUrl = abilities?.spellIconUrls[index] ?? null;
          const name = abilities?.spellNames[index] ?? `${key} ability`;
          const rank = key === 'R' ? -1 : maxOrder.indexOf(key as AbilitySlot);
          return (
            <li key={key} className="skill-order-tile">
              {iconUrl !== null ? (
                <img src={iconUrl} alt={name} width={32} height={32} className="skill-order-tile-icon" />
              ) : (
                <span className="skill-order-tile-icon skill-order-tile-icon--letter" aria-label={name}>
                  {key}
                </span>
              )}
              <span className="skill-order-tile-key">{key}</span>
              {rank >= 0 ? (
                <span className="skill-order-tile-badge" aria-label={`maxed ${String(rank + 1)}`}>
                  {BADGE[rank]}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <table className="skill-order-grid">
        <caption className="sr-only">Ability leveled at each champion level</caption>
        <thead>
          <tr>
            <th scope="col" aria-label="Ability" />
            {Array.from({ length: levels }, (_unused, i) => (
              <th key={i} scope="col" className="skill-order-grid-level">
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SLOT_KEYS.map((key, index) => {
            const slot = index + 1;
            return (
              <tr key={key}>
                <th scope="row" className="skill-order-grid-ability">
                  {key}
                </th>
                {perLevel.map((leveled, level) => (
                  <td
                    key={level}
                    className={
                      leveled === slot ? 'skill-order-grid-cell skill-order-grid-cell--on' : 'skill-order-grid-cell'
                    }
                  >
                    {leveled === slot ? level + 1 : ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface SkillOrderViewProps {
  /** Riot champion key, e.g. `Ahri` / `MonkeyKing`. */
  championName: string;
  skillOrder: readonly number[];
}

/** The match Build Path tab's entry point — derives the chart's props from the
 * per-level array the match timeline produces. */
export function SkillOrderView({ championName, skillOrder }: SkillOrderViewProps) {
  return (
    <SkillOrderChart
      championKey={championName}
      perLevel={skillOrder}
      maxOrder={maxOrderFromSkillOrder(skillOrder)}
    />
  );
}
