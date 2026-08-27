/**
 * Renders a rune tree's Data Dragon icon, or an Asset_Placeholder naming the
 * tree when it cannot be resolved.
 *
 * `match-detail-tabs` task 4.3 — Requirements 7.11, 8.1, 8.3, 8.4. Resolved
 * against the UNVERSIONED path (Requirement 7.4), same as `RuneIcon`.
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface RuneTreeIconProps {
  styleId: number;
  size: number;
  className?: string;
}

export function RuneTreeIcon({ styleId, size, className }: RuneTreeIconProps) {
  const provider = useStaticData();
  const url = provider.runeTreeIconUrl(styleId);
  const name = provider.runeTreeDisplayName(styleId);

  return <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />;
}
