/**
 * Cookie / analytics consent banner, shown as a modal on first visit.
 *
 * The site uses Google Analytics 4, which sets first-party `_ga` cookies once
 * it is allowed to. Consent Mode v2 defaults every storage type to "denied" in
 * `index.html`, so GA runs cookieless until this banner is answered:
 *  - "Accept" persists `granted` and calls `gtag('consent','update',...)`;
 *  - "Decline", Escape, or a backdrop click persists `denied`;
 *  - a stored choice is re-applied on every load without showing the banner.
 *
 * The visitor can change their mind later from the Cookie Policy page, which
 * clears the stored flag and reloads.
 *
 * It is a centered modal rather than a footer strip on purpose: the landing
 * page runs a brief GPU probe on first load (see `ShaderBackground`), and a
 * visitor reading this card is not watching the animated background settle.
 *
 * Every `localStorage` access is wrapped (the API throws when storage is
 * disabled by policy or in some private-browsing modes) — a dismissal we cannot
 * persist has not really happened, so the banner simply returns next load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readStoredConsent, setAnalyticsConsent, type AnalyticsConsent } from '../analytics';

export function CookieNotice() {
  // Start hidden so the modal never flashes for a visitor who already chose;
  // the effect below reveals it after the client-side storage check.
  const [visible, setVisible] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const stored = readStoredConsent();
    if (stored !== undefined) {
      // Re-apply the remembered decision to GA and stay out of the way.
      setAnalyticsConsent(stored);
      return;
    }
    setVisible(true);
  }, []);

  const choose = useCallback((consent: AnalyticsConsent) => {
    setAnalyticsConsent(consent, true);
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    acceptRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // Closing without an explicit choice is treated as "decline" — the safe
      // default — but the flag is still written so we don't nag on every load.
      if (event.key === 'Escape') {
        choose('denied');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, choose]);

  if (!visible) {
    return null;
  }

  return (
    <div className="storage-modal-backdrop" onClick={() => choose('denied')}>
      <div
        className="storage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="storage-modal-title" className="storage-modal-title">
          Cookies &amp; analytics
        </p>
        <p className="storage-modal-copy">
          lolprofiles.gg keeps a small game-asset index in your browser&rsquo;s local storage so pages
          load faster — that never leaves your device and is always on. Separately, we&rsquo;d like to
          use Google Analytics, which sets cookies, to measure which pages get used. Analytics stays
          off unless you accept. See the <a href="/cookies">Cookie Policy</a> and{' '}
          <a href="/privacy">Privacy Policy</a>.
        </p>
        <div className="storage-modal-actions">
          <button
            ref={acceptRef}
            type="button"
            className="btn btn-primary"
            onClick={() => choose('granted')}
          >
            Accept analytics
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => choose('denied')}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
