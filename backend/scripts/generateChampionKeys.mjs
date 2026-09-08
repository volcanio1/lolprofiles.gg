/**
 * Regenerates `backend/src/champions/championKeys.ts` from Data Dragon.
 *
 *   node backend/scripts/generateChampionKeys.mjs [version]
 *
 * `version` defaults to the `DDRAGON_VERSION` in `backend/.env.example` so the
 * bundled champion set tracks the same pinned release the rest of the app renders
 * assets from (specs/champion-build-stats/ task 1.2).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'champions', 'championKeys.ts');
const envExample = join(here, '..', '.env.example');

function pinnedVersion() {
  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;
  const match = readFileSync(envExample, 'utf8').match(/^DDRAGON_VERSION=(.+)$/m);
  if (!match) throw new Error('Could not read DDRAGON_VERSION from .env.example; pass a version argument.');
  return match[1].trim();
}

const version = pinnedVersion();
const url = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
const body = await response.json();

const entries = Object.values(body.data)
  .map((champion) => [champion.id, champion.name])
  .sort((a, b) => a[0].localeCompare(b[0]));

const rows = entries.map(([id, name]) => `  ['${id}', ${JSON.stringify(name)}],`);

const file = `/**
 * champion-build-stats — the closed set of valid \`Champion_Key\`s and their
 * display names (specs/champion-build-stats/ task 1.2).
 *
 * GENERATED FILE. Do not hand-edit the map below. Regenerate it with:
 *
 *     node backend/scripts/generateChampionKeys.mjs
 *
 * which fetches Data Dragon \`champion.json\` at the version pinned in
 * \`backend/.env.example\` (\`DDRAGON_VERSION\`) and rewrites the list.
 *
 * Why a bundled list rather than a runtime fetch: the endpoint needs to tell "is
 * this a champion key" from "is this junk" so it can 404 (Requirement 10.3), and
 * needs the display name for the response's \`champion.name\` (Requirement 11.1).
 * The set changes a few times a year, on a Riot patch we already redeploy for
 * (the frontend's \`DDRAGON_VERSION\` bump). A runtime Data Dragon fetch + cache
 * would be the backend's first, for data this small and slow-moving.
 */

export const CHAMPION_KEYS_DDRAGON_VERSION = '${version}';

/** \`Champion_Key\` → display name, at \`CHAMPION_KEYS_DDRAGON_VERSION\`, sorted by key. */
export const CHAMPION_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
${rows.join('\n')}
]);

/** Every valid \`Champion_Key\`. */
export const CHAMPION_KEYS: ReadonlySet<string> = new Set<string>(CHAMPION_NAMES.keys());

/**
 * Requirement 10.3: whether \`:championKey\` names a real champion. The endpoint
 * 404s when this is \`false\` and never touches the stats store.
 */
export function isKnownChampionKey(key: string): boolean {
  return CHAMPION_KEYS.has(key);
}

/** The display name for a \`Champion_Key\` (Requirement 11.1); the key itself if unknown. */
export function championDisplayName(key: string): string {
  return CHAMPION_NAMES.get(key) ?? key;
}
`;

writeFileSync(target, file);
console.log(`Wrote ${entries.length} champions for ${version} to ${target}`);
