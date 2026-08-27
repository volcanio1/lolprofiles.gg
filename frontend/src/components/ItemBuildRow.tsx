/**
 * Renders one participant's final item build: six item slots in position order,
 * plus a visually distinct trinket slot.
 *
 * Task 7.1 — Requirements 3.3, 3.5, 3.6, 3.7.
 *
 * ---------------------------------------------------------------------------
 * WHY A NULL BUILD RENDERS NOTHING AT ALL
 * ---------------------------------------------------------------------------
 *
 * Requirement 3.7 wants no opposing build and no empty opposing slots when no
 * Enemy_Laner was identified. Returning `null` here — rather than six empty-slot
 * placeholders — is what lets the caller pass `match.opponent?.build ?? null`
 * without a branch of its own; the "nothing to show" decision lives in exactly
 * one place.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EMPTY SLOT AND AN UNRESOLVABLE ITEM GET DIFFERENT LABELS
 * ---------------------------------------------------------------------------
 *
 * `0` is not a failure — it is the encoding for "nothing in this slot" — while a
 * non-zero id the provider cannot resolve genuinely could not be loaded. Both
 * render an Asset_Placeholder (Requirement 5.4), but "Empty item slot" and
 * "<name> unavailable" describe two different, distinguishable situations rather
 * than collapsing them into one ambiguous label.
 */

import { useState } from 'react';
import { useStaticData } from '../staticData';
import type { ItemBuild } from '../api/types';
import { AssetPlaceholder } from './AssetPlaceholder';
import { Tooltip } from './Tooltip';

function ItemSlot({ id, size, className }: { id: number; size: number; className?: string }) {
  const provider = useStaticData();
  const [failed, setFailed] = useState(false);

  if (id === 0) {
    return <AssetPlaceholder size={size} label="Empty item slot" className={className} />;
  }

  const url = failed ? null : provider.itemIconUrl(id);
  const name = provider.itemDisplayName(id);

  if (url === null) {
    return (
      <Tooltip title={name}>
        <AssetPlaceholder size={size} label={`${name} unavailable`} className={className} />
      </Tooltip>
    );
  }

  return (
    <Tooltip title={name} description={provider.itemDescription(id)}>
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        className={className}
        onError={() => setFailed(true)}
      />
    </Tooltip>
  );
}

export interface ItemBuildRowProps {
  build: ItemBuild | null;
  size: number;
  className?: string;
}

export function ItemBuildRow({ build, size, className }: ItemBuildRowProps) {
  if (build === null) {
    return null;
  }

  return (
    <ul className={className ? `item-build-row ${className}` : 'item-build-row'} role="list">
      {build.items.map((id, index) => (
        <li key={index} className="item-build-slot">
          <ItemSlot id={id} size={size} className="item-build-icon" />
        </li>
      ))}
      <li className="item-build-slot item-build-slot--trinket">
        <ItemSlot id={build.trinket} size={size} className="item-build-icon item-build-icon--trinket" />
      </li>
    </ul>
  );
}
