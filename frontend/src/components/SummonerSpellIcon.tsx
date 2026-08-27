/**
 * Renders a summoner spell's Data Dragon icon, or an Asset_Placeholder naming the
 * spell when it cannot be resolved.
 *
 * `match-detail-tabs` task 4.3 — Requirements 7.11, 8.1, 8.2, 8.4.
 *
 * Unlike `ChampionIcon`, this icon has no adjacent text naming its subject — the
 * scoreboard and mirrored row show bare spell icons — so `alt` carries the
 * resolved name rather than being empty, and the placeholder names the spell
 * rather than only describing an absence (`AssetPlaceholder`'s decision 2).
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface SummonerSpellIconProps {
  spellId: number;
  size: number;
  className?: string;
}

export function SummonerSpellIcon({ spellId, size, className }: SummonerSpellIconProps) {
  const provider = useStaticData();
  const url = provider.summonerSpellIconUrl(spellId);
  const name = provider.summonerSpellDisplayName(spellId);

  return <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />;
}
