/**
 * Renders the winged ranked-tier crest for a League-V4 `tier` string, or an
 * `AssetPlaceholder` at the same footprint when the tier is not one of the ten
 * real tiers or the crest cannot be loaded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT GO THROUGH `CdnImage`
 * ---------------------------------------------------------------------------
 *
 * `CdnImage` sets `width` and `height` to the same `size`, which is right for
 * every square Data_Dragon asset. Riot's ranked crests
 * (`ranked-emblem/emblem-{tier}.png`, the same artwork the League wiki shows)
 * are 16:9 canvases — 1280x720, or 2560x1440 for a few tiers — with the crest
 * itself centred and occupying only the middle fifth of the width. Forcing that
 * into a square box both distorts it and renders the crest at a fraction of the
 * intended size.
 *
 * The crests ARE consistently centred, so the fix is a fixed square viewport
 * with the image scaled up and overflow clipped (`.rank-crest` in styles.css):
 * the surrounding transparent canvas is cropped away and the crest fills the
 * box. Per-tier art differences (Challenger's wings spread wider than Iron's)
 * still show through as a small size difference — that is true of the source
 * art everywhere it is used.
 *
 * The error-to-placeholder swap that `CdnImage` owns is reimplemented here for
 * the same reason `CdnImage` has it: a tier whose crest 404s must reserve its
 * box and say what is missing rather than tear the card (Requirement 5.3).
 */

import { useState } from 'react';

import { AssetPlaceholder } from './AssetPlaceholder';
import { useStaticData } from '../staticData';

export interface RankIconProps {
  tier: string;
  /** Edge length of the square viewport in pixels. */
  size: number;
  className?: string;
}

export function RankIcon({ tier, size, className }: RankIconProps) {
  const provider = useStaticData();
  const [failed, setFailed] = useState(false);
  const url = failed ? null : provider.rankEmblemUrl(tier);

  if (url === null) {
    return <AssetPlaceholder size={size} label="Rank crest unavailable" className={className} />;
  }

  return (
    <span
      className={className ? `rank-crest ${className}` : 'rank-crest'}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <img src={url} alt="" onError={() => setFailed(true)} />
    </span>
  );
}
