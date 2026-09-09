/**
 * Renders a champion's Data Dragon icon beside its display name, or an
 * Asset_Placeholder at the same size when the icon cannot be resolved.
 *
 * Task 4.2 — Requirements 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 5.1. Refactored onto
 * `CdnImage` by `match-detail-tabs` task 4.2, which consolidates the
 * resolve/render/error-swap logic this component used to implement on its own —
 * see `CdnImage`'s own header for why. This file keeps only what is specific to
 * a champion icon: resolving the URL and display name, and rendering the name as
 * adjacent text.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE'S `alt` IS EMPTY
 * ---------------------------------------------------------------------------
 *
 * The Champion_Display_Name is rendered as adjacent text (Requirement 6.5), so a
 * non-empty `alt` would make a screen reader announce the same name twice. The
 * name text is the one required alternative; the icon is decorative alongside it.
 */

import { Link } from 'react-router-dom';

import { championPathFor } from '../domain/championSuggestions';
import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface ChampionIconProps {
  championKey: string;
  size: number;
  className?: string;
  /**
   * When true (the default), the champion's name links to that champion's build
   * page (`/champion/:key`). Pass false where the icon already sits inside
   * another interactive element — e.g. a search suggestion row — so the markup
   * does not nest one clickable control in another.
   */
  linkName?: boolean;
}

export function ChampionIcon({ championKey, size, className, linkName = true }: ChampionIconProps) {
  const provider = useStaticData();
  const url = provider.championIconUrl(championKey);
  const name = provider.championDisplayName(championKey);
  // Only link when the key resolves to a known champion — a numeric-id fallback
  // (or a key from a newer patch) would just land on the "not recognised" page.
  const linked = linkName && url !== null;

  return (
    <span className="champion-icon-label">
      <CdnImage url={url} alt="" fallbackLabel="Champion icon unavailable" size={size} className={className} />
      {linked ? (
        <Link to={championPathFor(championKey)} className="champion-icon-name champion-name-link">
          {name}
        </Link>
      ) : (
        <span className="champion-icon-name">{name}</span>
      )}
    </span>
  );
}
