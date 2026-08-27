/**
 * The single Data_Dragon/Community_Dragon image primitive.
 *
 * `match-detail-tabs` task 4.1 — Requirements 7.11, 9.3, 8.1.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN SIX HAND-WRITTEN COPIES
 * ---------------------------------------------------------------------------
 *
 * `visual-assets` produced `ChampionIcon` and `ProfileIcon`, each independently
 * implementing: resolve a URL, render `<img>` with an `onError` that swaps to
 * `AssetPlaceholder`, render `AssetPlaceholder` immediately when the URL is
 * `null`. This feature adds four more asset classes (summoner spell, rune, rune
 * tree, stat shard). Six hand-written copies of that logic is six places for the
 * error-swap to be forgotten, and `visual-assets` Requirement 5.3 ("never render
 * an image whose source could not be constructed") has to hold in all of them.
 * This component owns the swap once; the six typed wrappers become one-liners
 * over it (design.md decision 5).
 *
 * ---------------------------------------------------------------------------
 * WHY THE `error` EVENT IS ALSO A SWAP TRIGGER, NOT ONLY A NULL `url`
 * ---------------------------------------------------------------------------
 *
 * A `null` url covers an identifier the Static_Data_Provider already knows is
 * unresolvable (absent from the pinned metadata). It does not cover a URL the
 * provider considered resolvable but that 404s in practice — a filename
 * mismatch, a CDN hiccup, or (per `match-detail-tabs` Requirement 7.4) a rune
 * icon at the unversioned path that has moved. `failed` remembers that outcome
 * for the render and swaps to the placeholder rather than looping the browser
 * on a request that will never succeed.
 */

import { useState } from 'react';
import { AssetPlaceholder } from './AssetPlaceholder';

export interface CdnImageProps {
  /** The resolved asset URL, or `null` when the identifier could not be resolved at all. */
  url: string | null;
  /**
   * The image's text alternative. Pass `""` when the subject is already rendered
   * as adjacent text (e.g. `ChampionIcon`'s champion name); pass the resolved
   * display name when the icon stands alone (e.g. a bare rune or spell icon).
   */
  alt: string;
  /**
   * The `AssetPlaceholder`'s text alternative when `url` is `null` or the image
   * fails to load. Its wording convention depends on whether `alt` is empty —
   * see `AssetPlaceholder`'s documented decision 2.
   */
  fallbackLabel: string;
  /** Edge length in pixels. Passed to `AssetPlaceholder` unchanged (Requirement 5.1). */
  size: number;
  className?: string;
}

export function CdnImage({ url, alt, fallbackLabel, size, className }: CdnImageProps) {
  const [failed, setFailed] = useState(false);

  const effectiveUrl = failed ? null : url;

  if (effectiveUrl === null) {
    return <AssetPlaceholder size={size} label={fallbackLabel} className={className} />;
  }

  return (
    <img
      src={effectiveUrl}
      alt={alt}
      width={size}
      height={size}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
