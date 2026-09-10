/**
 * Google Analytics 4 (gtag.js) — the typed surface the app calls.
 *
 * The loader and the Consent Mode v2 defaults (every storage type "denied")
 * live in `index.html`, so they run before this module and before GA can write
 * a cookie. This file only:
 *  - applies / persists the visitor's consent decision (`setAnalyticsConsent`);
 *  - records SPA page views on route change (`trackPageView`, via `usePageViews`);
 *  - records product events (`trackEvent`).
 *
 * Every function is a no-op when `window.gtag` is absent — tests, SSR, an
 * extension that blocked the loader — so callers never have to guard.
 *
 * PRIVACY: we deliberately do NOT send URL query strings to GA. A `/profile` or
 * `/live` URL carries a player's Riot ID in `?riotId=`, and that has no business
 * in an analytics report. Page views are recorded by path only; events carry
 * just the coarse fields named at each call site (a champion key, an error
 * code, a result bucket).
 */

const MEASUREMENT_ID = 'G-4JNLMDBL0X';

/** localStorage key holding `'granted'` | `'denied'` once the banner is answered. */
export const ANALYTICS_CONSENT_KEY = 'lp:analytics-consent';

export type AnalyticsConsent = 'granted' | 'denied';

type GtagFn = (...args: unknown[]) => void;

function gtag(): GtagFn | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const fn = (window as unknown as { gtag?: GtagFn }).gtag;
  return typeof fn === 'function' ? fn : undefined;
}

/** The stored consent decision, or `undefined` if the visitor hasn't answered. */
export function readStoredConsent(): AnalyticsConsent | undefined {
  try {
    const value = window.localStorage.getItem(ANALYTICS_CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pushes a consent decision to GA and, when `persist` is set, remembers it.
 * Called on every load with the restored value, and again (with `persist`) when
 * the visitor clicks an Accept / Decline button.
 */
export function setAnalyticsConsent(consent: AnalyticsConsent, persist = false): void {
  const granted = consent === 'granted';
  gtag()?.('consent', 'update', {
    analytics_storage: granted ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  if (persist) {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, consent);
    } catch {
      // A decision we can't store just means the banner returns next load.
    }
  }
}

/** Forgets the stored decision so the consent banner shows again. */
export function clearAnalyticsConsent(): void {
  try {
    window.localStorage.removeItem(ANALYTICS_CONSENT_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Records a `page_view` for `path` (pathname only — never the query string). */
export function trackPageView(path: string): void {
  gtag()?.('event', 'page_view', {
    page_path: path,
    page_location: window.location.origin + path,
    page_title: document.title,
    send_to: MEASUREMENT_ID,
  });
}

/** Records a product event. Keep `params` to coarse, non-identifying fields. */
export function trackEvent(name: string, params: Record<string, unknown> = {}): void {
  gtag()?.('event', name, params);
}
