import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_CONSENT_KEY,
  clearAnalyticsConsent,
  readStoredConsent,
  setAnalyticsConsent,
  trackEvent,
  trackPageView,
} from './analytics';

/**
 * The wrapper's job is to be safe (no-op without `window.gtag`) and to keep
 * consent and page-path data flowing to GA in the shape Consent Mode expects —
 * in particular, never leaking a query string.
 */

function stubGtag() {
  const gtag = vi.fn();
  vi.stubGlobal('gtag', gtag);
  return gtag;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('analytics wrapper', () => {
  it('does nothing when gtag is absent', () => {
    // No throw is the whole assertion.
    expect(() => {
      trackEvent('player_search', { method: 'submit' });
      trackPageView('/profile');
      setAnalyticsConsent('granted');
    }).not.toThrow();
  });

  it('forwards a consent grant to gtag and can persist it', () => {
    const gtag = stubGtag();

    setAnalyticsConsent('granted', true);

    expect(gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'granted', ad_storage: 'denied' }),
    );
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('granted');
    expect(readStoredConsent()).toBe('granted');
  });

  it('does not persist unless asked', () => {
    stubGtag();
    setAnalyticsConsent('denied');
    expect(readStoredConsent()).toBeUndefined();
  });

  it('clears a stored decision', () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted');
    clearAnalyticsConsent();
    expect(readStoredConsent()).toBeUndefined();
  });

  it('ignores a garbage stored value', () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, 'maybe');
    expect(readStoredConsent()).toBeUndefined();
  });

  it('sends only the pathname for a page view, never a query string', () => {
    const gtag = stubGtag();

    trackPageView('/profile');

    expect(gtag).toHaveBeenCalledWith(
      'event',
      'page_view',
      expect.objectContaining({ page_path: '/profile' }),
    );
    const [, , params] = gtag.mock.calls[0] as [string, string, Record<string, string>];
    expect(params.page_path).not.toContain('?');
    expect(params.page_location).not.toContain('?');
  });
});
