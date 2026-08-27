/**
 * Renders a stat shard's icon, or an Asset_Placeholder naming the shard when it
 * cannot be resolved.
 *
 * `match-detail-tabs` task 4.3 — Requirements 7.11, 8.1, 8.3, 8.4. Resolved
 * against the UNVERSIONED path, from the hardcoded identifier-to-file table
 * `provider.ts` holds — Data_Dragon publishes no stat shard metadata at all
 * (Requirement 7.7), which is why `statShardIconUrl`/`statShardDisplayName` work
 * even before the fetched index is ready.
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface StatShardIconProps {
  shardId: number;
  size: number;
  className?: string;
}

export function StatShardIcon({ shardId, size, className }: StatShardIconProps) {
  const provider = useStaticData();
  const url = provider.statShardIconUrl(shardId);
  const name = provider.statShardDisplayName(shardId);

  return <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />;
}
