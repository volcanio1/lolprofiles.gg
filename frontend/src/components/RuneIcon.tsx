/**
 * Renders a rune's Data Dragon icon, or an Asset_Placeholder naming the rune when
 * it cannot be resolved.
 *
 * `match-detail-tabs` task 4.3 — Requirements 7.11, 8.1, 8.3, 8.4. Resolved
 * against the UNVERSIONED path (Requirement 7.4) — `provider.runeIconUrl`
 * already applies that, so this component only wires the id through.
 *
 * No adjacent text names the rune, so `alt` carries the resolved name and the
 * placeholder names the rune rather than only describing an absence
 * (`AssetPlaceholder`'s decision 2).
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface RuneIconProps {
  runeId: number;
  size: number;
  className?: string;
}

export function RuneIcon({ runeId, size, className }: RuneIconProps) {
  const provider = useStaticData();
  const url = provider.runeIconUrl(runeId);
  const name = provider.runeDisplayName(runeId);

  return <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />;
}
