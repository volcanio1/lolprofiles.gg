/**
 * Renders the analyzed player's Data Dragon profile icon, or an Asset_Placeholder
 * at the same size when it cannot be resolved.
 *
 * Task 4.2 — Requirements 1.1, 2.1, 2.2, 2.3, 2.4, 5.1.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE'S OWN `error` EVENT IS THE ONLY WAY TO CATCH AN UNRESOLVABLE ID
 * ---------------------------------------------------------------------------
 *
 * `provider.profileIconUrl` resolves as soon as the pinned version is known,
 * without consulting any metadata — Data Dragon never publishes a
 * `profileicon.json` index to check membership against (see `provider.ts`). So a
 * profile icon added after the pinned release, or removed from it, produces a
 * live URL that 404s at request time; the `error` handler is Requirement 2.4's
 * only mechanism for catching that and swapping to the placeholder.
 */

import { useState } from 'react';
import { useStaticData } from '../staticData';
import { AssetPlaceholder } from './AssetPlaceholder';

export interface ProfileIconProps {
  profileIconId: number | null;
  size: number;
  className?: string;
}

export function ProfileIcon({ profileIconId, size, className }: ProfileIconProps) {
  const provider = useStaticData();
  const [failed, setFailed] = useState(false);

  const url = failed ? null : provider.profileIconUrl(profileIconId);

  if (url === null) {
    return <AssetPlaceholder size={size} label="Profile icon unavailable" className={className} />;
  }

  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
