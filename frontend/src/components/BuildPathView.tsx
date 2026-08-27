/**
 * The analyzed player's build path for one match, drawn as a left-to-right flow:
 * every item acquisition in order, connected, with the game time it happened at.
 *
 * `item-timeline` task 8.1 — Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 6.3.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE WHOLE SEQUENCE IS SHOWN BY DEFAULT — consumables, wards and boots
 *    included. A "Legendary items only" toggle collapses it to completed items
 *    (`isCompletedItem`, the one classification source `visual-assets` pins,
 *    Requirement 3.2). The toggle is hidden until the metadata index loads,
 *    because before then nothing can be classified.
 *
 * 2. A SOLD ITEM APPEARS TWICE. Purchases and sales are merged into one
 *    time-ordered flow: a normal buy node at the buy time, and a separate dimmed
 *    "sold" marker at `soldAt` (from the backend). The item was genuinely bought
 *    AND genuinely sold, each at a distinct moment (Requirement 2.3).
 *
 * 3. TRINKET NODES BOOKEND THE FLOW. The game grants and swaps trinkets with no
 *    reliable purchase event, so the replay does not carry them cleanly. A
 *    leading "start" node shows the starting trinket — the default yellow
 *    Stealth Ward (3340) unless the timeline shows a different trinket bought in
 *    the first 7 seconds, in which case that is the one selected. A trailing
 *    "final" node shows `finalBuild.trinket` only when it differs from the
 *    start (i.e. the player swapped mid-game).
 *
 * 4. TIMES ARE `M:SS` FROM MATCH START (Requirement 3.4). A game past the hour
 *    shows a two-or-more-digit minute field; minutes are not wrapped.
 *
 * 5. AN UNRESOLVABLE ITEM KEEPS ITS PLACE (Requirement 6.3) as an
 *    `AssetPlaceholder` whose label carries the raw id.
 *
 * 6. THE UNRECONCILED CAVEAT LIVES HERE (Requirement 4.3); the path is still
 *    shown in full (Requirement 4.5).
 */

import { useState } from 'react';
import type { BuildPathEntry, ItemBuild } from '../api/types';
import { useStaticData } from '../staticData';
import { AssetPlaceholder } from './AssetPlaceholder';
import { Tooltip } from './Tooltip';

const ICON_SIZE = 32;

/** Warding Totem / Farsight Alteration / Oracle Lens. */
const TRINKET_IDS = new Set([3340, 3363, 3364]);
const DEFAULT_TRINKET_ID = 3340; // yellow Stealth Ward, auto-selected at game start
/** A trinket bought within this window is the player's chosen starting trinket, not a mid-game swap. */
const START_TRINKET_MS = 7000;

/** Milliseconds from match start -> `M:SS`. Negative or non-finite -> `0:00`. */
export function formatMatchTime(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function BuildPathItem({ itemId }: { itemId: number }) {
  const provider = useStaticData();
  const [failed, setFailed] = useState(false);

  const name = provider.itemDisplayName(itemId);
  const url = failed ? null : provider.itemIconUrl(itemId);

  if (url === null) {
    return (
      <Tooltip title={name}>
        <AssetPlaceholder size={ICON_SIZE} label={`${name} unavailable`} className="build-path-icon" />
      </Tooltip>
    );
  }

  return (
    <Tooltip title={name} description={provider.itemDescription(itemId)}>
      <img
        src={url}
        alt={name}
        width={ICON_SIZE}
        height={ICON_SIZE}
        className="build-path-icon"
        onError={() => setFailed(true)}
      />
    </Tooltip>
  );
}

export interface BuildPathViewProps {
  buildPath: readonly BuildPathEntry[];
  /** False when the replay did not reconcile with the reported final build (Requirement 4.3). */
  reconciled: boolean;
  /** The match's reported final build — used only to append the trinket node (decision 3). */
  finalBuild?: ItemBuild;
}

export function BuildPathView({ buildPath, reconciled, finalBuild }: BuildPathViewProps) {
  const provider = useStaticData();
  const [legendaryOnly, setLegendaryOnly] = useState(false);

  const canClassify = provider.ready;
  const filtering = legendaryOnly && canClassify;

  // The starting trinket: whichever trinket was bought in the first 7s, else the
  // default yellow Stealth Ward. That early buy (if any) is folded into the
  // "start" node rather than shown inline.
  const startTrinketPurchase = buildPath.find(
    (entry) => TRINKET_IDS.has(entry.itemId) && entry.timestamp < START_TRINKET_MS,
  );
  const startTrinketId = startTrinketPurchase?.itemId ?? DEFAULT_TRINKET_ID;

  const base = buildPath.filter((entry) => entry !== startTrinketPurchase);
  const shown = filtering ? base.filter((entry) => provider.isCompletedItem(entry.itemId)) : base;

  const finalTrinket = finalBuild?.trinket ?? 0;
  const finalTrinketId = finalTrinket !== 0 && finalTrinket !== startTrinketId ? finalTrinket : 0;

  // Merge purchases and sales into one time-ordered flow: a buy node at the buy
  // time, and — for a sold item — a separate "sold" marker at the sell time.
  const flowNodes: { kind: 'buy' | 'sell'; key: string; itemId: number; time: number }[] = [];
  shown.forEach((entry, i) => {
    flowNodes.push({ kind: 'buy', key: `b${String(i)}`, itemId: entry.itemId, time: entry.timestamp });
    if (entry.soldAt !== undefined) {
      flowNodes.push({ kind: 'sell', key: `s${String(i)}`, itemId: entry.itemId, time: entry.soldAt });
    }
  });
  flowNodes.sort((a, b) => a.time - b.time);

  return (
    <div className="build-path-view" data-testid="build-path-view">
      {!reconciled ? (
        <p className="build-path-caveat" data-testid="build-path-caveat">
          This build path may be incomplete — it could not be fully reconciled with the final items.
        </p>
      ) : null}

      {canClassify ? (
        <button
          type="button"
          className="build-path-toggle"
          aria-pressed={legendaryOnly}
          onClick={() => setLegendaryOnly((value) => !value)}
        >
          {legendaryOnly ? 'Show all items' : 'Legendary items only'}
        </button>
      ) : null}

      {shown.length === 0 && !filtering ? (
        <p className="build-path-empty">No item purchases were recorded for this match.</p>
      ) : shown.length === 0 ? (
        <p className="build-path-empty">No legendary items in this build path.</p>
      ) : (
        <ol className="build-path-flow">
          <li className="build-path-node build-path-node--trinket">
            <span className="build-path-node-item">
              <BuildPathItem itemId={startTrinketId} />
              <span className="build-path-time">start</span>
            </span>
          </li>
          {flowNodes.map((node) => (
            <li
              key={node.key}
              className={node.kind === 'sell' ? 'build-path-node build-path-node--sold' : 'build-path-node'}
            >
              <span className="build-path-connector" aria-hidden="true" />
              <span className="build-path-node-item">
                <BuildPathItem itemId={node.itemId} />
                <span className="build-path-time">{formatMatchTime(node.time)}</span>
                {node.kind === 'sell' ? <span className="build-path-sold-tag">sold</span> : null}
              </span>
            </li>
          ))}
          {finalTrinketId !== 0 ? (
            <li className="build-path-node build-path-node--trinket">
              <span className="build-path-connector build-path-connector--trinket" aria-hidden="true" />
              <span className="build-path-node-item">
                <BuildPathItem itemId={finalTrinketId} />
                <span className="build-path-time">final</span>
              </span>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}
