/**
 * Insight Engine — build-path reducer and reconciler (`item-timeline` feature).
 *
 * PURE MODULE, same constraints as `stats.ts`: no network, no cache, no clock
 * read, no `process.env`, no logging, no import that could perform I/O. Every
 * value comes from the events the caller supplies. That is what makes Properties
 * 1, 3 and 4 property-testable without fakes.
 *
 * `replayShopEvents` reconstructs the ordered sequence of item acquisitions one
 * participant actually completed in a match, from Match-V5's timeline event
 * stream. It is NOT a filtered list of `ITEM_PURCHASED` events: players use the
 * shop's undo button routinely, an undone purchase emits no compensating sell,
 * and filtering for purchases produces a build containing items the player never
 * owned. The replay is a fold with undo applied as the reversal of a prior
 * action.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `ITEM_UNDO` POLARITY, confirmed against real KR solo-queue data on
 *    2026-08-27 (spec task 1.1; see specs/item-timeline/design.md). An undo
 *    describes the inventory transition it causes as `beforeId -> afterId`:
 *      - undo of a PURCHASE: `{ beforeId: <bought item>, afterId: 0 }`
 *      - undo of a SELL:     `{ beforeId: 0, afterId: <sold item> }`
 *    Stacked undos (repeated undo presses) emit one event per step, each naming
 *    the specific item that step reverses, so undos are matched to prior actions
 *    by item id, not by recency alone.
 *
 * 2. SELL AND DESTROY LEAVE THE BUILD PATH ALONE (Requirements 2.3, 2.4). A
 *    component absorbed into a completed item is destroyed, and a starting item
 *    sold at the first back was still genuinely bought — removing either from the
 *    path would erase real history. They only remove from the reconstructed
 *    inventory. Only an undo removes a build-path entry, because an undone
 *    purchase is the one case where the acquisition did not happen. A SELL does,
 *    though, record its own timestamp on the acquisition as `soldAt` so the UI
 *    can show the item at both the buy time and the (later) sell time.
 *
 * 2b. RECONCILIATION NORMALISES BOOTS AND EXCLUDES TRINKETS. The game upgrades
 *    S15 boots and swaps trinkets with no purchase event, so a literal
 *    end-inventory-vs-Final_Build comparison flags builds that are actually
 *    fine. `reconcile` collapses every boot to one id and drops the trinket slot
 *    before comparing. This is the only place a documented, verified item
 *    behaviour (task 10.1) is compensated for — the build path itself is never
 *    altered.
 *
 * 3. TOTAL AND DEFENSIVE. Response shapes are validated downstream of the Riot
 *    client, not in it (see orchestrator/mapping.ts decision 4); this reducer is
 *    that downstream. An event whose numeric fields are missing or non-finite,
 *    or whose `type` is not one of the four Shop_Events, is ignored rather than
 *    throwing. An undo that matches no outstanding action is a no-op. One
 *    malformed event can never fail a build-path derivation.
 *
 * 4. PARAMETERISED BY PARTICIPANT SLOT (Requirement 7.1). The slot is an
 *    argument, so extracting the lane opponent's build path later is a second
 *    call with a different slot, not a change to this logic.
 */

import type { ItemBuild } from './stats';

/**
 * The four Match-V5 timeline events that change a participant's inventory, plus a
 * catch-all for every other event type the reducer ignores. Deliberately narrow:
 * `participantFrames` (gold, xp, position) is out of scope (Requirement 7.2) and
 * is not modelled here so it cannot be reached for.
 */
export type TimelineEventDto =
  | { type: 'ITEM_PURCHASED'; timestamp: number; participantId: number; itemId: number }
  | { type: 'ITEM_SOLD'; timestamp: number; participantId: number; itemId: number }
  | { type: 'ITEM_DESTROYED'; timestamp: number; participantId: number; itemId: number }
  | {
      type: 'ITEM_UNDO';
      timestamp: number;
      participantId: number;
      beforeId: number;
      afterId: number;
      goldGain?: number;
    }
  | { type: 'SKILL_LEVEL_UP'; timestamp: number; participantId: number; skillSlot: number }
  | { type: string; timestamp?: number };

export interface BuildPathEntry {
  itemId: number;
  /** Milliseconds from match start when the item was bought. */
  timestamp: number;
  /**
   * Milliseconds from match start when this specific acquisition was later sold
   * back to the shop. Present only when the item was sold; the entry stays in
   * the build path (it was genuinely bought) and the UI marks it with this time.
   */
  soldAt?: number;
}

export interface ReplayResult {
  /** Acquisitions in non-decreasing timestamp order, undone purchases removed. */
  buildPath: readonly BuildPathEntry[];
  /** Items held at the end of the replay, as a multiset (one entry per instance). */
  finalInventory: readonly number[];
}

/**
 * The entire retained artifact for one player's build path in one match — a few
 * kilobytes, against a 1-5 MB source (item-timeline design.md). Cached under the
 * `timelineSlice` endpoint keyed `{ matchId, puuid }` with indefinite retention;
 * the raw Match_Timeline it is derived from is never cached.
 */
export interface TimelineSlice {
  matchId: string;
  puuid: string;
  buildPath: readonly BuildPathEntry[];
  /**
   * The ability leveled at each level-up, in order, as Match-V5 `skillSlot`
   * values: 1 = Q, 2 = W, 3 = E, 4 = R. Length is the player's final level (up
   * to 18).
   */
  skillOrder: readonly number[];
  /** Requirement 4.2/4.3: false when the replay end-state disagreed with the Final_Build. */
  reconciled: boolean;
}

export interface Reconciliation {
  reconciled: boolean;
  /** Non-empty only when `reconciled` is false. Drives Requirement 4.4 logging. */
  missingFromReplay?: readonly number[];
  unexpectedInReplay?: readonly number[];
}

function isShopType(type: string): boolean {
  return (
    type === 'ITEM_PURCHASED' || type === 'ITEM_SOLD' || type === 'ITEM_DESTROYED' || type === 'ITEM_UNDO'
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One acquisition tracked during the fold; `undone` entries are dropped at the end. */
interface Acquisition {
  itemId: number;
  timestamp: number;
  undone: boolean;
  /** Timestamp of the ITEM_SOLD matched to this acquisition; cleared if that sell is undone. */
  soldAt?: number;
}

/** A recorded sell that has not yet been reversed by an undo. */
interface OutstandingSell {
  itemId: number;
  /** Index into `acquisitions` of the acquisition this sell was charged against, if any. */
  acquisitionIndex?: number;
}

function removeOneInstance(inventory: number[], itemId: number): void {
  const at = inventory.lastIndexOf(itemId);
  if (at !== -1) {
    inventory.splice(at, 1);
  }
}

/**
 * Fold over `events` belonging to `participantSlot` only, in ascending timestamp
 * order (stable for equal timestamps, preserving the stream's own ordering).
 * Requirements 2.1-2.7, 7.1, 7.2.
 */
export function replayShopEvents(
  events: readonly TimelineEventDto[],
  participantSlot: number,
): ReplayResult {
  const mine = events
    .filter(
      (event): event is Extract<TimelineEventDto, { participantId: number }> =>
        typeof event.type === 'string' &&
        isShopType(event.type) &&
        finiteNumber((event as { participantId?: unknown }).participantId) === participantSlot,
    )
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const at = finiteNumber(a.event.timestamp) ?? 0;
      const bt = finiteNumber(b.event.timestamp) ?? 0;
      return at === bt ? a.index - b.index : at - bt;
    })
    .map(({ event }) => event);

  const acquisitions: Acquisition[] = [];
  const inventory: number[] = [];
  const outstandingSells: OutstandingSell[] = [];

  for (const event of mine) {
    if (event.type === 'ITEM_PURCHASED') {
      const itemId = finiteNumber((event as { itemId?: unknown }).itemId);
      const timestamp = finiteNumber(event.timestamp);
      if (itemId === undefined || timestamp === undefined) {
        continue;
      }
      acquisitions.push({ itemId, timestamp, undone: false });
      inventory.push(itemId);
      continue;
    }

    if (event.type === 'ITEM_SOLD') {
      const itemId = finiteNumber((event as { itemId?: unknown }).itemId);
      if (itemId === undefined) {
        continue;
      }
      const soldAt = finiteNumber(event.timestamp);
      removeOneInstance(inventory, itemId);
      // Record the sell time on the most recent live, not-already-sold acquisition
      // of this item, so the build path shows it was bought and then sold, each
      // with its own timestamp (Requirement 2.3).
      let acquisitionIndex: number | undefined;
      for (let i = acquisitions.length - 1; i >= 0; i--) {
        if (acquisitions[i].itemId === itemId && !acquisitions[i].undone && acquisitions[i].soldAt === undefined) {
          acquisitions[i].soldAt = soldAt ?? acquisitions[i].timestamp;
          acquisitionIndex = i;
          break;
        }
      }
      outstandingSells.push({ itemId, acquisitionIndex });
      continue;
    }

    if (event.type === 'ITEM_DESTROYED') {
      const itemId = finiteNumber((event as { itemId?: unknown }).itemId);
      if (itemId === undefined) {
        continue;
      }
      removeOneInstance(inventory, itemId);
      continue;
    }

    // ITEM_UNDO
    const beforeId = finiteNumber((event as { beforeId?: unknown }).beforeId);
    const afterId = finiteNumber((event as { afterId?: unknown }).afterId);

    if (beforeId !== undefined && beforeId !== 0 && afterId === 0) {
      // Undo of a purchase: drop the most recent not-yet-undone acquisition of
      // this item and remove one instance from the inventory.
      for (let i = acquisitions.length - 1; i >= 0; i--) {
        if (acquisitions[i].itemId === beforeId && !acquisitions[i].undone) {
          acquisitions[i].undone = true;
          break;
        }
      }
      removeOneInstance(inventory, beforeId);
      continue;
    }

    if (afterId !== undefined && afterId !== 0 && beforeId === 0) {
      // Undo of a sell: restore one instance to the inventory and un-mark the
      // acquisition the sell was charged against. The build path entry itself
      // was never removed by the sell.
      const at = outstandingSells.map((sell) => sell.itemId).lastIndexOf(afterId);
      if (at !== -1) {
        const [sell] = outstandingSells.splice(at, 1);
        inventory.push(afterId);
        if (sell.acquisitionIndex !== undefined) {
          acquisitions[sell.acquisitionIndex].soldAt = undefined;
        }
      }
    }
  }

  return {
    buildPath: acquisitions
      .filter((acquisition) => !acquisition.undone)
      .map(({ itemId, timestamp, soldAt }) =>
        soldAt === undefined ? { itemId, timestamp } : { itemId, timestamp, soldAt },
      ),
    finalInventory: [...inventory].sort((a, b) => a - b),
  };
}

/**
 * The ability the player leveled at each level-up, in time order, as `skillSlot`
 * values (1=Q, 2=W, 3=E, 4=R). Pure, total: a malformed or out-of-range slot is
 * skipped. Only the analyzed slot's `SKILL_LEVEL_UP` events are read.
 */
export function extractSkillOrder(
  events: readonly TimelineEventDto[],
  participantSlot: number,
): number[] {
  return events
    .filter(
      (event) =>
        event.type === 'SKILL_LEVEL_UP' &&
        finiteNumber((event as { participantId?: unknown }).participantId) === participantSlot,
    )
    .map((event, index) => ({
      slot: finiteNumber((event as { skillSlot?: unknown }).skillSlot),
      timestamp: finiteNumber(event.timestamp) ?? 0,
      index,
    }))
    .filter((entry): entry is { slot: number; timestamp: number; index: number } =>
      entry.slot !== undefined && entry.slot >= 1 && entry.slot <= 4,
    )
    .sort((a, b) => (a.timestamp === b.timestamp ? a.index - b.index : a.timestamp - b.timestamp))
    .map((entry) => entry.slot);
}

function toMultiset(items: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

/** Every id in `a` that `b` does not cover, repeated by the shortfall count, ascending. */
function multisetDifference(a: readonly number[], b: readonly number[]): number[] {
  const bCounts = toMultiset(b);
  const difference: number[] = [];
  for (const [itemId, count] of toMultiset(a)) {
    const shortfall = count - (bCounts.get(itemId) ?? 0);
    for (let i = 0; i < shortfall; i++) {
      difference.push(itemId);
    }
  }
  return difference.sort((x, y) => x - y);
}

/**
 * Item ids that reconciliation ignores on BOTH sides, because the game changes
 * them without an `ITEM_PURCHASED` the replay can see (item-timeline task 10.1 —
 * see design.md):
 *
 *  - **Boots.** An S15 tier-2 boot upgrades in place at level 13+: the timeline
 *    emits `ITEM_DESTROYED` for the tier-2 boot and nothing for the tier-3, so
 *    the replay ends with NO boot while the Final_Build reports the tier-3. The
 *    tier-2 purchase is still in the build path — the UI shows it — but the
 *    boot slot cannot be reconciled against the end state.
 *  - **Trinkets.** Granted and swapped for free (Farsight/Oracle sometimes emit
 *    a 0-gold purchase, sometimes not), so the slot is not reconstructable.
 *  - **Seeker's Armguard.** `2420` transforms in place to the weaker `2421`
 *    (Shattered Armguard) when its shield breaks — no purchase event.
 *
 * These are the only behaviours a documented, verified finding (task 10.1)
 * compensates for; the build path itself is never altered, and the list only
 * grows when real-data sampling confirms another in-place transform.
 */
const RECONCILE_IGNORED_IDS: ReadonlySet<number> = new Set([
  // boots — tier 1, tier 2, event, and every tier-3 in-place upgrade
  1001, 2422, 3005, 3006, 3008, 3009, 3010, 3013, 3020, 3047, 3111, 3117, 3158, 3168, 3170, 3171, 3172, 3173, 3174,
  3175, 3176,
  // trinkets
  3340, 3363, 3364,
  // Seeker's Armguard <-> Shattered Armguard (shield-break transform)
  2420, 2421,
]);

/**
 * Compare the replay's end-state inventory against the Final_Build that
 * `visual-assets` captures from the match detail, as multisets (Requirement 4),
 * ignoring the item classes above. Does not repair, suppress, or discard an
 * unreconciled result — it only reports the difference in both directions so the
 * caller can log it (Requirement 4.5).
 */
export function reconcile(finalInventory: readonly number[], finalBuild: ItemBuild): Reconciliation {
  const keep = (id: number): boolean => !RECONCILE_IGNORED_IDS.has(id);
  const reported = finalBuild.items.filter((itemId) => itemId !== 0 && keep(itemId));
  const inventory = finalInventory.filter(keep);

  const missingFromReplay = multisetDifference(reported, inventory);
  const unexpectedInReplay = multisetDifference(inventory, reported);

  if (missingFromReplay.length === 0 && unexpectedInReplay.length === 0) {
    return { reconciled: true };
  }
  return { reconciled: false, missingFromReplay, unexpectedInReplay };
}
