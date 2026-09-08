/**
 * Regenerates `backend/src/insight/completedItems.ts` from Data Dragon.
 *
 *   node backend/scripts/generateCompletedItems.mjs [version]
 *
 * `version` defaults to the `DDRAGON_VERSION` in `backend/.env.example`.
 *
 * A "completed item" for champion-build-stats-pipeline's purposes = something a
 * core build slot is filled with: purchasable on Summoner's Rift, in the store,
 * builds into nothing further (`into` empty), not a consumable / trinket, and
 * expensive enough not to be a starter (≥ 1100g, or ≥ 900g for a boot). This
 * catches legendary items and the current tier-3 boots and excludes components,
 * Doran's items, potions, wards, and (on the current season) the tier-2 boots
 * that now build into the tier-3s.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'insight', 'completedItems.ts');
const envExample = join(here, '..', '.env.example');

const version =
  process.argv[2]?.trim() ||
  readFileSync(envExample, 'utf8').match(/^DDRAGON_VERSION=(.+)$/m)?.[1].trim();
if (!version) throw new Error('No version: pass one or set DDRAGON_VERSION in .env.example');

const url = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
const { data } = await response.json();

const isBoot = (it) => (it.tags ?? []).includes('Boots');
const rows = Object.entries(data)
  .map(([id, it]) => ({ id: Number(id), it }))
  .filter(
    ({ id, it }) =>
      id < 30_000 &&
      it.maps?.['11'] === true &&
      it.inStore !== false &&
      it.gold?.purchasable === true &&
      (it.into ?? []).length === 0 &&
      !(it.tags ?? []).includes('Consumable') &&
      !(it.tags ?? []).includes('Trinket') &&
      (it.gold?.total ?? 0) >= (isBoot(it) ? 900 : 1100),
  )
  .sort((a, b) => a.id - b.id);

const ids = rows.map((r) => r.id);
const bootIds = rows.filter((r) => isBoot(r.it)).map((r) => r.id);
const fmt = (arr) => {
  let out = '';
  for (let i = 0; i < arr.length; i += 14) out += `  ${arr.slice(i, i + 14).join(', ')},\n`;
  return out;
};

writeFileSync(
  target,
  `/**
 * champion-build-stats-pipeline: the Summoner's Rift completed-item id set at a
 * pinned Data Dragon version (task 4). Used by the crawler's extractor to reduce
 * a full purchase history to the core build.
 *
 * GENERATED FILE. Regenerate with:
 *
 *     node backend/scripts/generateCompletedItems.mjs
 *
 * Pinned at one version while the crawler aggregates recent patches; an item
 * reworked component<->legendary between the pin and a crawled patch is
 * misclassified. Accepted — regenerate on deploy. See the script for the rule.
 */

export const COMPLETED_ITEMS_DDRAGON_VERSION = '${version}';

/** Every SR completed-item id at \`COMPLETED_ITEMS_DDRAGON_VERSION\`, sorted. */
export const COMPLETED_ITEM_IDS: ReadonlySet<number> = new Set<number>([
${fmt(ids)}]);

/** The current tier-3 boot ids (a subset of \`COMPLETED_ITEM_IDS\`). */
export const BOOT_ITEM_IDS: ReadonlySet<number> = new Set<number>([
${fmt(bootIds)}]);

/** Whether \`itemId\` fills a core build slot (a legendary item or a finished boot). */
export function isCompletedItemId(itemId: number): boolean {
  return COMPLETED_ITEM_IDS.has(itemId);
}
`,
);
console.log(`Wrote ${ids.length} completed items (${bootIds.length} boots) for ${version} to ${target}`);
