/**
 * Renders a champion's Data Dragon icon beside its display name, or an
 * Asset_Placeholder at the same size when the icon cannot be resolved.
 *
 * Task 4.2 — Requirements 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 5.1.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE'S OWN `error` EVENT IS ALSO A SWAP TRIGGER
 * ---------------------------------------------------------------------------
 *
 * The Static_Data_Provider fetches `champion.json`, so a Champion_Key absent from
 * the pinned release already resolves to `null` before any request is made — the
 * `useState` here only exists to cover the residual gap: a URL the provider
 * considered resolvable but that 404s in practice (a filename mismatch, a CDN
 * hiccup). Once an `<img>` reports `error`, this component remembers it for that
 * render and shows the placeholder instead, rather than looping the browser on a
 * request that will never succeed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE'S `alt` IS EMPTY
 * ---------------------------------------------------------------------------
 *
 * The Champion_Display_Name is rendered as adjacent text (Requirement 6.5), so a
 * non-empty `alt` would make a screen reader announce the same name twice. The
 * name text is the one required alternative; the icon is decorative alongside it.
 */

import { useState } from 'react';
import { useStaticData } from '../staticData';
import { AssetPlaceholder } from './AssetPlaceholder';

export interface ChampionIconProps {
  championKey: string;
  size: number;
  className?: string;
}

export function ChampionIcon({ championKey, size, className }: ChampionIconProps) {
  const provider = useStaticData();
  const [failed, setFailed] = useState(false);

  const url = failed ? null : provider.championIconUrl(championKey);
  const name = provider.championDisplayName(championKey);

  return (
    <span className="champion-icon-label">
      {url === null ? (
        <AssetPlaceholder size={size} label="Champion icon unavailable" className={className} />
      ) : (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          className={className}
          onError={() => setFailed(true)}
        />
      )}
      <span className="champion-icon-name">{name}</span>
    </span>
  );
}
