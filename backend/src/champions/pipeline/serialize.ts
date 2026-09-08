/**
 * champion-build-stats-pipeline: MongoDB-field-name-safe serialization of the
 * values that become keys in an Aggregate_Doc's frequency sub-maps (task 6).
 *
 * PURE MODULE. Every `serializeX` / `parseX` is a total round-trip. Keys must
 * contain no `.` and no leading `$` (Mongo field-name rules) and must be
 * non-empty. Separators used: `-` within a list, `:` between a rune style and
 * its selections, `_` between rune groups, `~` between a skill order's max part
 * and its per-level part. `"none"` is the empty-list sentinel.
 */

import type { RunePage } from '../../insight/stats';
import type { AbilitySlot } from '../../insight/skillOrder';

export interface SkillOrderValue {
  maxOrder: readonly AbilitySlot[];
  perLevel: readonly number[];
}

const EMPTY = 'none';

function serializeIds(ids: readonly number[]): string {
  return ids.length === 0 ? EMPTY : ids.join('-');
}

function parseIds(key: string): number[] {
  return key === EMPTY ? [] : key.split('-').map(Number);
}

// --- item path -------------------------------------------------------------

export function serializeItemPath(coreItems: readonly number[]): string {
  return serializeIds(coreItems);
}
export function parseItemPath(key: string): number[] {
  return parseIds(key);
}

// --- starting items -------------------------------------------------------

export function serializeStartingItems(ids: readonly number[]): string {
  return serializeIds(ids);
}
export function parseStartingItems(key: string): number[] {
  return parseIds(key);
}

// --- spell pair ----------------------------------------------------------

export function serializeSpellPair(pair: readonly [number, number]): string {
  return `${String(pair[0])}-${String(pair[1])}`;
}
export function parseSpellPair(key: string): [number, number] {
  const [a, b] = key.split('-').map(Number);
  return [a ?? 0, b ?? 0];
}

// --- skill order -------------------------------------------------------

export function serializeSkillOrder(value: SkillOrderValue): string {
  const max = value.maxOrder.length === 0 ? EMPTY : value.maxOrder.join('');
  const levels = value.perLevel.length === 0 ? EMPTY : value.perLevel.join('-');
  return `${max}~${levels}`;
}
export function parseSkillOrder(key: string): SkillOrderValue {
  const [max, levels] = key.split('~');
  return {
    maxOrder:
      max === EMPTY || max === undefined
        ? []
        : (max.split('').filter((c): c is AbilitySlot => c === 'Q' || c === 'W' || c === 'E')),
    perLevel: levels === EMPTY || levels === undefined ? [] : levels.split('-').map(Number),
  };
}

// --- rune page ---------------------------------------------------------

export function serializeRunePage(runes: RunePage): string {
  const primary = `${String(runes.primaryStyle)}:${serializeIds(runes.primarySelections)}`;
  const secondary = `${String(runes.secondaryStyle)}:${serializeIds(runes.secondarySelections)}`;
  const shards = runes.statShards.join('-');
  return `${primary}_${secondary}_${shards}`;
}
export function parseRunePage(key: string): RunePage {
  const [primary = '', secondary = '', shards = ''] = key.split('_');
  const [primaryStyle = '0', primarySel = EMPTY] = primary.split(':');
  const [secondaryStyle = '0', secondarySel = EMPTY] = secondary.split(':');
  const shard = shards.split('-').map(Number);
  return {
    primaryStyle: Number(primaryStyle),
    secondaryStyle: Number(secondaryStyle),
    primarySelections: parseIds(primarySel),
    secondarySelections: parseIds(secondarySel),
    statShards: [shard[0] ?? 0, shard[1] ?? 0, shard[2] ?? 0],
  };
}
