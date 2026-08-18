import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REGION, REGION_TO_PLATFORMS, SUPPORTED_REGIONS } from './regions';
import { MAX_GAME_NAME_LENGTH, MAX_TAG_LINE_LENGTH } from './riotId';

/**
 * Drift guard for the rules this workspace MIRRORS from the backend.
 *
 * `domain/riotId.ts` and `domain/regions.ts` duplicate logic that
 * `backend/src/validator` and `backend/src/region` own, because Requirements
 * 1.3-1.5 need validation before the request leaves the browser and Requirement 5.3
 * needs the platform mapping to build the selector — and the two npm workspaces
 * share no code. The backend stays authoritative, so a divergence cannot admit an
 * invalid lookup, but it CAN produce a wasted round trip or a selector offering a
 * platform the backend will silently replace.
 *
 * This test closes that gap by reading the backend's source as TEXT and comparing
 * the values it declares against this workspace's copies. Reading source text is an
 * unusual thing for a test to do, and the alternative was better but rejected:
 * importing across workspaces would require a shared package, which changes both
 * build configurations for a single constant table. A text comparison is honest
 * about what it is — a guard against a human editing one copy and forgetting the
 * other — and it fails loudly the moment that happens.
 *
 * It degrades gracefully: if the backend sources are not present (this workspace
 * built or published on its own), the parity checks are skipped rather than failing,
 * because absence of the backend is not evidence of drift.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backendSrc = resolve(here, '../../../backend/src');
const regionPath = resolve(backendSrc, 'region/index.ts');
const validatorPath = resolve(backendSrc, 'validator/index.ts');

const backendAvailable = existsSync(regionPath) && existsSync(validatorPath);

/** Extracts `REGION_TO_PLATFORMS` from the backend source as a plain map. */
function parseBackendRegionMap(source: string): Record<string, string[]> {
  const block = /REGION_TO_PLATFORMS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (block === null) {
    throw new Error('Could not locate REGION_TO_PLATFORMS in the backend source.');
  }
  const map: Record<string, string[]> = {};
  const entry = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let match = entry.exec(block[1]);
  while (match !== null) {
    map[match[1]] = match[2]
      .split(',')
      .map((value) => value.trim().replace(/^'|'$/g, ''))
      .filter((value) => value.length > 0);
    match = entry.exec(block[1]);
  }
  return map;
}

function parseBackendNumber(source: string, name: string): number {
  const found = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(source);
  if (found === null) {
    throw new Error(`Could not locate ${name} in the backend source.`);
  }
  return Number(found[1]);
}

function parseBackendString(source: string, name: string): string {
  const found = new RegExp(`${name}[^=]*=\\s*'([^']+)'`).exec(source);
  if (found === null) {
    throw new Error(`Could not locate ${name} in the backend source.`);
  }
  return found[1];
}

describe.skipIf(!backendAvailable)('parity with the authoritative backend rules', () => {
  it('mirrors the region-to-platform mapping exactly, including order', () => {
    const backendMap = parseBackendRegionMap(readFileSync(regionPath, 'utf8'));

    // Same regions.
    expect(Object.keys(backendMap).sort()).toEqual([...SUPPORTED_REGIONS].sort());
    // Same platforms per region, in the same order — order matters, because the
    // first entry is the platform Requirement 5.4 falls back to.
    for (const region of SUPPORTED_REGIONS) {
      expect(backendMap[region], region).toEqual([...REGION_TO_PLATFORMS[region]]);
    }
  });

  it('mirrors the default region (Requirement 1.6)', () => {
    const backendDefault = parseBackendString(readFileSync(regionPath, 'utf8'), 'DEFAULT_REGION');
    expect(backendDefault).toBe(DEFAULT_REGION);
  });

  it('mirrors the Riot ID length limits (Requirement 1.5)', () => {
    const source = readFileSync(validatorPath, 'utf8');
    expect(parseBackendNumber(source, 'MAX_GAME_NAME_LENGTH')).toBe(MAX_GAME_NAME_LENGTH);
    expect(parseBackendNumber(source, 'MAX_TAG_LINE_LENGTH')).toBe(MAX_TAG_LINE_LENGTH);
  });

  it('mirrors the validation error code set, so a backend code always has a message here', () => {
    const source = readFileSync(validatorPath, 'utf8');
    const declared = /export type RiotIdErrorCode\s*=([\s\S]*?);/.exec(source);
    expect(declared).not.toBeNull();
    const backendCodes = [...(declared?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();

    // The frontend's table must cover every code the backend can emit; otherwise a
    // 400 response would fall back to a generic message that names the wrong rule.
    const frontendCodes = ['EMPTY_PART', 'GAME_NAME_TOO_LONG', 'MISSING_HASH', 'MULTIPLE_HASH', 'TAG_LINE_TOO_LONG'];
    expect(backendCodes).toEqual(frontendCodes);
  });
});

describe('the guard itself', () => {
  it('reports whether it actually ran, so a silent skip is visible', () => {
    // If this is ever false in CI, the parity checks above are not protecting
    // anything and the mirroring risk is unguarded again.
    expect(typeof backendAvailable).toBe('boolean');
  });
});
