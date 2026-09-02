/**
 * "Support us" banner — a compact first-party donation strip in the site footer.
 *
 * Rendered by `RiotDataPage`, so it appears once on every page, below the
 * content and above the Riot attribution: present on each visit without
 * interrupting a lookup.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT THE AD SLOT
 * ---------------------------------------------------------------------------
 *
 * Requirement 12.2 prohibits third-party advertisements, sponsored content and
 * paid promotional banners on pages rendering Riot data, and `advertisingPolicy`
 * enforces that with a single, deliberate override point. A link asking our own
 * visitors to help pay for hosting is first-party and sells nobody's product, so
 * it sits outside that gate — but it deliberately borrows none of the ad slot's
 * machinery, so the prohibition keeps exactly one enforcement path.
 *
 * The destination comes from `donateUrl` (see config.ts). An empty value renders
 * nothing at all, which is the off switch: a banner pointing at a dead link is
 * worse than no banner.
 */

import { donateUrl } from '../config';

export interface SupportBannerProps {
  /** Injected in tests; production reads the configured URL. */
  url?: string;
}

export function SupportBanner({ url = donateUrl }: SupportBannerProps = {}) {
  if (url.trim().length === 0) {
    return null;
  }

  return (
    <aside className="support-banner" data-testid="support-banner" aria-label="Support lolprofiles.gg">
      <p className="support-banner-text">
        <span className="support-banner-title">Support us</span>
        <span className="support-banner-copy">
          lolprofiles.gg is free and ad-free. A donation keeps the servers running.
        </span>
      </p>
      <a
        className="btn btn-ghost support-banner-link"
        data-testid="support-banner-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Donate
      </a>
    </aside>
  );
}
