/**
 * Renders the analyzed player's Data Dragon profile icon, or an Asset_Placeholder
 * at the same size when it cannot be resolved.
 *
 * Task 4.2 — Requirements 1.1, 2.1, 2.2, 2.3, 2.4, 5.1. Refactored onto `CdnImage`
 * by `match-detail-tabs` task 4.2 — see that component's header for why a single
 * primitive replaces this one's former hand-written resolve/render/error-swap
 * logic. `CdnImage`'s own `error`-event handling is still what catches a profile
 * icon id that resolves to a URL but 404s in practice (`provider.profileIconUrl`
 * never consults metadata, since Data Dragon publishes none for profile icons).
 */

import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface ProfileIconProps {
  profileIconId: number | null;
  size: number;
  className?: string;
}

export function ProfileIcon({ profileIconId, size, className }: ProfileIconProps) {
  const provider = useStaticData();
  const url = provider.profileIconUrl(profileIconId);

  return <CdnImage url={url} alt="" fallbackLabel="Profile icon unavailable" size={size} className={className} />;
}
