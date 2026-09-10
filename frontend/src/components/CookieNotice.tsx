/**
 * One-time storage notice.
 *
 * lolprofiles.gg sets no cookies and runs no ad/tracking scripts, so this is not
 * a consent gate — nothing is withheld until you click, and there is nothing to
 * opt out of. It is a short disclosure that the site keeps a trimmed game-asset
 * index in `localStorage`, with a link to the Cookie Policy, shown once and then
 * dismissed for good.
 *
 * Every `localStorage` access is wrapped: the API throws (not returns null) when
 * storage is disabled by policy or in some private-browsing modes, and a notice
 * component must never be the thing that breaks a page. If storage is
 * unavailable we simply keep showing the notice — which is also the honest
 * outcome, since a dismissal we cannot persist has not really happened.
 */

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'lp:storage-notice-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Nothing to do — the notice reappears next load, which is acceptable.
  }
}

export function CookieNotice() {
  // Start hidden so the notice never flashes for a visitor who already
  // dismissed it; `useEffect` reveals it after the client-side storage check.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!readDismissed()) {
      setVisible(true);
    }
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="cookie-notice" role="region" aria-label="Storage notice">
      <p className="cookie-notice-copy">
        This site sets no cookies and runs no ad or tracking scripts. It keeps a small game-asset
        index in your browser&rsquo;s local storage so pages load faster.{' '}
        <a href="/cookies">Learn more</a>.
      </p>
      <button
        type="button"
        className="btn btn-ghost cookie-notice-dismiss"
        onClick={() => {
          persistDismissed();
          setVisible(false);
        }}
      >
        Got it
      </button>
    </div>
  );
}
