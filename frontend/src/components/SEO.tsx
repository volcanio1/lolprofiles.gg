/**
 * Per-page SEO metadata: document title, meta description, canonical link,
 * and Open Graph / Twitter Card tags for link previews.
 *
 * A thin wrapper around `react-helmet-async`'s `<Helmet>` so every page sets
 * these the same way instead of re-deriving the suffix/defaults/absolute-URL
 * logic per call site. `index.html` carries a static fallback of the same
 * tags for the instant before React mounts (or for a crawler that never runs
 * JS at all); `<Helmet>` overwrites them once it does.
 */

import { Helmet } from 'react-helmet-async';

const SITE_NAME = 'lolprofiles.gg';
const DEFAULT_DESCRIPTION =
  'Look up League of Legends ranked stats, match history, live games and player habits by Riot ID.';
/** Relative to the site origin; resolved to an absolute URL below (OG/Twitter want one). */
const DEFAULT_IMAGE_PATH = '/lp_logo.png';

export interface SEOProps {
  /** Page-specific title. The site name is appended automatically unless this already ends with it. */
  title: string;
  description?: string;
  /** Relative or absolute image URL for link previews. Defaults to the site logo. */
  image?: string;
  /** Excludes the page from search-engine indexing (dev/debug pages, error states). */
  noindex?: boolean;
}

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') {
    return path;
  }
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

export function SEO({ title, description = DEFAULT_DESCRIPTION, image = DEFAULT_IMAGE_PATH, noindex = false }: SEOProps) {
  const fullTitle = title.endsWith(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
  const canonicalUrl = typeof window === 'undefined' ? undefined : absoluteUrl(window.location.pathname + window.location.search);
  const imageUrl = absoluteUrl(image);

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {canonicalUrl !== undefined ? <link rel="canonical" href={canonicalUrl} /> : null}
      <meta name="robots" content={noindex ? 'noindex, nofollow' : 'index, follow'} />

      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:type" content="website" />
      {canonicalUrl !== undefined ? <meta property="og:url" content={canonicalUrl} /> : null}

      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />
    </Helmet>
  );
}
