/**
 * Renders an ARAM Mayhem augment's icon, or an Asset_Placeholder naming the
 * augment when it cannot be resolved.
 *
 * `match-detail-tabs` task 9.5 — Requirements 7.11 (mirrored for Community_Dragon
 * assets), 8.1, 12.3, 12.4, 12.7. Resolved from Community_Dragon, pinned to a
 * derived version — see `provider.ts`'s `augmentIconUrl`. No description or
 * tooltip is shown (Requirement 12.8) — the name is the only text this
 * component ever surfaces.
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface AugmentIconProps {
  augmentId: number;
  size: number;
  className?: string;
}

export function AugmentIcon({ augmentId, size, className }: AugmentIconProps) {
  const provider = useStaticData();
  const url = provider.augmentIconUrl(augmentId);
  const name = provider.augmentDisplayName(augmentId);

  return <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />;
}
