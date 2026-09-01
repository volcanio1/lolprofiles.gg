import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TTL_BY_ENDPOINT,
  buildCacheKey,
  createInMemoryCacheStore,
  isStale,
  type CacheEndpoint,
  type CacheKey,
  type InMemoryCacheStore,
} from './index';

const ENDPOINTS: readonly CacheEndpoint[] = [
  'account',
  'accountRegion',
  'summoner',
  'league',
  'matchIds',
  'matchDetail',
  'timelineSlice',
  'activeGame',
  'championMastery',
  'tournamentSchedule',
  'clashPlayers',
  'clashTeam',
  'championMasteryTop',
];

/**
 * Retention transcribed independently from Requirements 10.2-10.4 and design.md's
 * TTL table rather than imported, so the properties compare the module against
 * the specification instead of against itself.
 */
const EXPECTED_RETENTION_MS: Record<CacheEndpoint, number | 'infinite'> = {
  account: 60 * 60 * 1000,
  accountRegion: 24 * 60 * 60 * 1000,
  summoner: 60 * 60 * 1000,
  league: 10 * 60 * 1000,
  matchIds: 10 * 60 * 1000,
  matchDetail: 'infinite',
  timelineSlice: 'infinite',
  activeGame: 30 * 1000,
  championMastery: 60 * 60 * 1000,
  tournamentSchedule: 60 * 60 * 1000,
  clashPlayers: 5 * 60 * 1000,
  clashTeam: 5 * 60 * 1000,
  championMasteryTop: 60 * 60 * 1000,
};

/** Characters that a naive delimiter-joined encoding would alias on. */
const DELIMITERS = [':', '|', '#', '=', ','];

const tokenArb = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.constantFrom('', 'a', 'b', 'c', 'ab', ...DELIMITERS),
  fc
    .array(fc.oneof(fc.constantFrom(...DELIMITERS), fc.constantFrom('a', 'b', 'c', '1', '2')), {
      minLength: 1,
      maxLength: 5,
    })
    .map((chars) => chars.join('')),
);

const paramsArb = fc.dictionary(tokenArb, tokenArb, { maxKeys: 4 });

const endpointArb = fc.constantFrom(...ENDPOINTS);
const routingArb = fc.oneof(fc.constantFrom('americas', 'europe', 'na1', 'euw1', 'kr'), tokenArb);

const tupleArb: fc.Arbitrary<CacheKey> = fc.record({
  endpoint: endpointArb,
  routingValue: routingArb,
  params: paramsArb,
});

/** Shuffles a params object's insertion order without changing its content. */
function reorderedParams(params: Record<string, string>, rotation: number): Record<string, string> {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return {};
  }
  const offset = ((rotation % entries.length) + entries.length) % entries.length;
  const rotated = [...entries.slice(offset), ...entries.slice(0, offset)];
  return Object.fromEntries(rotated);
}

/**
 * Independently written oracle: tuple equality with `params` compared as an
 * unordered map (same key set, same value for every key).
 */
function tuplesEqual(a: CacheKey, b: CacheKey): boolean {
  if (a.endpoint !== b.endpoint || a.routingValue !== b.routingValue) {
    return false;
  }
  const aKeys = Object.keys(a.params);
  const bKeys = Object.keys(b.params);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (name) => Object.prototype.hasOwnProperty.call(b.params, name) && a.params[name] === b.params[name],
  );
}

type PairKind = 'reordered' | 'endpointMutated' | 'routingMutated' | 'paramsMutated' | 'independent';

interface Pair {
  left: CacheKey;
  right: CacheKey;
  kind: PairKind;
}

const pairArb: fc.Arbitrary<Pair> = tupleArb.chain((left) =>
  fc.oneof(
    // Equal content, different param insertion order
    fc.integer({ min: 0, max: 5 }).map((rotation) => ({
      left,
      right: { ...left, params: reorderedParams(left.params, rotation) },
      kind: 'reordered' as PairKind,
    })),
    // Differ in exactly one field
    endpointArb.map((endpoint) => ({
      left,
      right: { ...left, endpoint },
      kind: 'endpointMutated' as PairKind,
    })),
    routingArb.map((routingValue) => ({
      left,
      right: { ...left, routingValue },
      kind: 'routingMutated' as PairKind,
    })),
    paramsArb.map((params) => ({
      left,
      right: { ...left, params },
      kind: 'paramsMutated' as PairKind,
    })),
    // Fully independent tuples
    tupleArb.map((right) => ({ left, right, kind: 'independent' as PairKind })),
  ),
);

describe('Cache Store properties', () => {
  // Feature: lolprofiles-gg, Property 16: Cache key construction is deterministic and injective over its inputs
  // **Validates: Requirements 10.1**
  it('produces equal cache keys if and only if the (endpoint, routingValue, params) tuples are equal as unordered maps', () => {
    let equalKeyCount = 0;
    let differentKeyCount = 0;
    const kindCounts: Record<PairKind, number> = {
      reordered: 0,
      endpointMutated: 0,
      routingMutated: 0,
      paramsMutated: 0,
      independent: 0,
    };

    fc.assert(
      fc.property(pairArb, ({ left, right, kind }) => {
        kindCounts[kind] += 1;

        // Determinism: repeated construction of the same tuple is stable.
        expect(buildCacheKey(left)).toBe(buildCacheKey({ ...left, params: { ...left.params } }));

        const sameKey = buildCacheKey(left) === buildCacheKey(right);
        expect(sameKey).toBe(tuplesEqual(left, right));

        if (sameKey) {
          equalKeyCount += 1;
        } else {
          differentKeyCount += 1;
        }
      }),
      { numRuns: 300 },
    );

    // Guard against degenerate coverage: both branches of the biconditional and
    // every pair-construction strategy must have been exercised.
    expect(equalKeyCount).toBeGreaterThan(0);
    expect(differentKeyCount).toBeGreaterThan(0);
    for (const kind of Object.keys(kindCounts) as PairKind[]) {
      expect(kindCounts[kind]).toBeGreaterThan(0);
    }
  });

  // Feature: lolprofiles-gg, Property 17: Cache TTL staleness matches configured retention per endpoint type
  // **Validates: Requirements 10.2, 10.3, 10.4**
  it('keeps entries non-stale for at least their endpoint retention period, and never stales matchDetail', async () => {
    const elapsedArb = fc.oneof(
      fc.integer({ min: 0, max: 60 * 60 * 1000 }),
      fc.integer({ min: 0, max: 10 * 60 * 1000 }),
      fc.integer({ min: 0, max: 7 * 24 * 60 * 60 * 1000 }),
      fc.constantFrom(0, 1, 599_999, 600_000, 600_001, 3_599_999, 3_600_000, 3_600_001, Number.MAX_SAFE_INTEGER),
    );

    let staleCount = 0;
    let nonStaleCount = 0;
    let infiniteCount = 0;
    const endpointCounts: Record<CacheEndpoint, number> = {
      account: 0,
      accountRegion: 0,
      summoner: 0,
      league: 0,
      matchIds: 0,
      matchDetail: 0,
      timelineSlice: 0,
      activeGame: 0,
      championMastery: 0,
      tournamentSchedule: 0,
      clashPlayers: 0,
      clashTeam: 0,
      championMasteryTop: 0,
    };

    await fc.assert(
      fc.asyncProperty(endpointArb, elapsedArb, fc.integer({ min: 0, max: 1_000_000 }), async (endpoint, elapsed, start) => {
        endpointCounts[endpoint] += 1;

        // Fake clock only: no real timers, no wall-clock reads.
        let current = start;
        const store = createInMemoryCacheStore({ now: () => current });
        const key: CacheKey = { endpoint, routingValue: 'na1', params: { puuid: 'p-1' } };

        await store.set(key, 'payload', TTL_BY_ENDPOINT[endpoint]);
        const entry = await store.get<string>(key);
        expect(entry).toBeDefined();
        expect(entry?.retrievedAt).toBe(start);

        current = start + elapsed;
        const stale = isStale(entry!, current);

        const retention = EXPECTED_RETENTION_MS[endpoint];
        if (retention === 'infinite') {
          // Requirement 10.4
          infiniteCount += 1;
          expect(stale).toBe(false);
        } else if (elapsed <= retention) {
          // Requirements 10.2 / 10.3: retained for at least the retention period
          expect(stale).toBe(false);
        } else {
          expect(stale).toBe(true);
        }

        if (stale) {
          staleCount += 1;
        } else {
          nonStaleCount += 1;
        }
      }),
      { numRuns: 300 },
    );

    // Guard against degenerate coverage.
    expect(staleCount).toBeGreaterThan(0);
    expect(nonStaleCount).toBeGreaterThan(0);
    expect(infiniteCount).toBeGreaterThan(0);
    for (const endpoint of ENDPOINTS) {
      expect(endpointCounts[endpoint]).toBeGreaterThan(0);
    }
  });
});

/**
 * Property 20 fixtures.
 *
 * The PUUID pool is deliberately non-prefix-free-safe: no pool member is a
 * substring of another, so "PUUID appears nowhere" assertions cannot be
 * accidentally satisfied or violated by substring overlap between distinct
 * players.
 */
const PUUID_POOL = ['puuid-a', 'puuid-b', 'puuid-c', 'puuid-d', 'puuid-e'] as const;

interface OwnerSpec {
  puuid: string;
  hasSummoner: boolean;
  hasLeague: boolean;
  hasMatchIds: boolean;
  hasAccount: boolean;
}

const ownerFlagsArb = fc.record({
  include: fc.boolean(),
  hasSummoner: fc.boolean(),
  hasLeague: fc.boolean(),
  hasMatchIds: fc.boolean(),
  hasAccount: fc.boolean(),
});

interface MatchSpec {
  matchId: string;
  participants: string[];
}

interface CacheStateSpec {
  target: string;
  owners: OwnerSpec[];
  matches: MatchSpec[];
}

const cacheStateArb: fc.Arbitrary<CacheStateSpec> = fc.record({
  target: fc.constantFrom(...PUUID_POOL),
  owners: fc
    .array(ownerFlagsArb, { minLength: PUUID_POOL.length, maxLength: PUUID_POOL.length })
    .map((flags): OwnerSpec[] =>
      flags
        .map((flag, index) => ({ puuid: PUUID_POOL[index], ...flag }))
        .filter((owner) => owner.include)
        .map(({ puuid, hasSummoner, hasLeague, hasMatchIds, hasAccount }) => ({
          puuid,
          hasSummoner,
          hasLeague,
          hasMatchIds,
          hasAccount,
        })),
    ),
  matches: fc
    .array(fc.uniqueArray(fc.constantFrom(...PUUID_POOL), { minLength: 1, maxLength: 4 }), { maxLength: 3 })
    .map((matches) => matches.map((participants, index) => ({ matchId: `NA1_${index}`, participants }))),
});

/** Participant record: identity fields plus gameplay statistics. */
function participantRecord(puuid: string, index: number) {
  return {
    puuid,
    // Deliberately embeds the PUUID: exhaustive redaction must catch it.
    summonerName: `Player_${puuid}`,
    summonerId: `summ-${puuid}`,
    riotIdGameName: `Name${index}`,
    riotIdTagline: `T${index}`,
    championName: ['Ahri', 'Garen', 'Lux', 'Yasuo', 'Thresh'][index % 5],
    teamPosition: ['MIDDLE', 'TOP', 'BOTTOM', 'JUNGLE', 'UTILITY'][index % 5],
    kills: index + 1,
    deaths: index,
    assists: index * 2,
    visionScore: index * 3,
    win: index % 2 === 0,
  };
}

async function buildStore(spec: CacheStateSpec, now: () => number) {
  const store = createInMemoryCacheStore({ now });

  for (const owner of spec.owners) {
    if (owner.hasSummoner) {
      await store.set(
        { endpoint: 'summoner', routingValue: 'na1', params: { puuid: owner.puuid } },
        { puuid: owner.puuid, summonerLevel: 100 },
        TTL_BY_ENDPOINT.summoner,
      );
    }
    if (owner.hasLeague) {
      await store.set(
        { endpoint: 'league', routingValue: 'na1', params: { puuid: owner.puuid } },
        [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II' }],
        TTL_BY_ENDPOINT.league,
      );
    }
    if (owner.hasMatchIds) {
      await store.set(
        { endpoint: 'matchIds', routingValue: 'americas', params: { puuid: owner.puuid } },
        ['NA1_0', 'NA1_1'],
        TTL_BY_ENDPOINT.matchIds,
      );
    }
    if (owner.hasAccount) {
      // account is keyed by Riot ID, NOT by PUUID, but its value carries the PUUID.
      await store.set(
        { endpoint: 'account', routingValue: 'americas', params: { gameName: `G-${owner.puuid}`, tagLine: 'NA1' } },
        { puuid: owner.puuid, gameName: `G-${owner.puuid}`, tagLine: 'NA1' },
        TTL_BY_ENDPOINT.account,
      );
    }
  }

  for (const match of spec.matches) {
    await store.set(
      { endpoint: 'matchDetail', routingValue: 'americas', params: { matchId: match.matchId } },
      {
        metadata: { matchId: match.matchId, participants: [...match.participants] },
        info: {
          gameDuration: 1800,
          participants: match.participants.map((puuid, index) => participantRecord(puuid, index)),
        },
      },
      TTL_BY_ENDPOINT.matchDetail,
    );
  }

  return store;
}

type DumpRecord = ReturnType<InMemoryCacheStore['dumpForVerification']>[number];

function snapshot(store: InMemoryCacheStore): Map<string, DumpRecord> {
  const clone = JSON.parse(JSON.stringify(store.dumpForVerification())) as DumpRecord[];
  return new Map(clone.map((record) => [record.encodedKey, record]));
}

describe('Cache Store deletion properties', () => {
  // Feature: lolprofiles-gg, Property 20: Deletion requests are idempotent and always answered
  // **Validates: Requirements 12.4, 12.5, 12.6**
  it('removes every entry referencing the PUUID, leaves other players untouched, and is idempotent', async () => {
    let foundCount = 0;
    let notFoundCount = 0;
    let matchDetailRemovalCount = 0;

    await fc.assert(
      fc.asyncProperty(cacheStateArb, fc.integer({ min: 0, max: 1_000_000 }), async (spec, start) => {
        // Fake clock only: no wall-clock reads.
        const store = await buildStore(spec, () => start);
        const target = spec.target;

        const before = snapshot(store);

        // Oracle for (d): does any data associated with the target exist?
        const expectedFound = [...before.values()].some((record) => {
          const inKey = Object.values(record.key.params).some((value) => value.includes(target));
          return inKey || JSON.stringify(record.entry.value).includes(target);
        });

        const result = await store.deleteByPuuid(target);

        // (d) `found` accurately reflects prior existence.
        expect(result.found).toBe(expectedFound);
        if (result.found) {
          foundCount += 1;
        } else {
          notFoundCount += 1;
        }
        if (result.removedMatchDetailCount > 0) {
          matchDetailRemovalCount += 1;
        }

        // (a) The PUUID appears nowhere in the cache: keys or values, any depth.
        // Serializing the entire store makes this exhaustive.
        expect(JSON.stringify(store.dumpForVerification())).not.toContain(target);

        const after = new Map(store.dumpForVerification().map((record) => [record.encodedKey, record]));

        for (const [encodedKey, priorRecord] of before) {
          const priorValueJson = JSON.stringify(priorRecord.entry.value);
          const referencedTarget =
            Object.values(priorRecord.key.params).some((value) => value.includes(target)) ||
            priorValueJson.includes(target);
          const currentRecord = after.get(encodedKey);

          if (referencedTarget) {
            // (c) EVERY entry referencing the target is gone, match details
            // included. Retaining a redacted match detail was the original design
            // and was abandoned: it left the entry personally identifying anyway
            // (nine other participants) while permanently emptying the subject's
            // future reports, because indefinitely-cached entries are never
            // re-fetched.
            expect(currentRecord, `${priorRecord.key.endpoint} entry survived`).toBeUndefined();
          } else {
            // (b) entries that never mentioned the target are completely
            // unchanged — no collateral eviction, no mutation.
            expect(currentRecord).toBeDefined();
            expect(JSON.parse(JSON.stringify(currentRecord!.entry))).toEqual(priorRecord.entry);
          }
        }

        // (e) idempotency: nothing left to find, cache byte-identical afterwards.
        const afterFirstJson = JSON.stringify(store.dumpForVerification());
        const second = await store.deleteByPuuid(target);
        expect(second).toEqual({ found: false, removedEntryCount: 0, removedMatchDetailCount: 0 });
        expect(JSON.stringify(store.dumpForVerification())).toBe(afterFirstJson);
      }),
      {
        numRuns: 200,
        /**
         * Deterministic coverage: a target that participates in a shared match
         * detail AND owns keyed entries, so both removal counters are exercised
         * regardless of seed, alongside a bystander whose data must survive.
         */
        examples: [
          [
            {
              target: 'puuid-a',
              owners: [
                { puuid: 'puuid-a', hasSummoner: true, hasLeague: true, hasMatchIds: true, hasAccount: true },
                { puuid: 'puuid-b', hasSummoner: true, hasLeague: true, hasMatchIds: true, hasAccount: true },
              ],
              matches: [{ matchId: 'NA1_0', participants: ['puuid-a', 'puuid-b'] }],
            },
            1_000,
          ],
        ] as [CacheStateSpec, number][],
      },
    );

    // Guard against degenerate coverage: both `found` branches, and real
    // match-detail eviction rather than only keyed-entry removal.
    expect(foundCount).toBeGreaterThan(0);
    expect(notFoundCount).toBeGreaterThan(0);
    expect(matchDetailRemovalCount).toBeGreaterThan(0);
  });
});
