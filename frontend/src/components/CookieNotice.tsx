/**
 * One-time storage notice, shown as a modal on first visit.
 *
 * lolprofiles.gg sets no cookies and runs no ad/tracking scripts, so this is not
 * a consent gate — nothing is withheld until you click, and there is nothing to
 * opt out of. It is a short disclosure that the site keeps a trimmed game-asset
 * index in `localStorage`, with a link to the Cookie Policy, shown once and then
 * dismissed for good.
 *
 * It is a centered modal rather than a footer strip on purpose: the landing page
 * runs a brief GPU probe on first load (see `ShaderBackground`), and a visitor
 * reading this card is not watching the animated background settle behind it.
 *
 * Every `localStorage` access is wrapped: the API throws (not returns null) when
 * storage is disabled by policy or in some private-browsing modes, and a notice
 * component must never be the thing that breaks a page. If storage is
 * unavailable we simply show the notice again next load — which is also the
 * honest outcome, since a dismissal we cannot persist has not really happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  // Start hidden so the modal never flashes for a visitor who already dismissed
  // it; the effect below reveals it after the client-side storage check.
  const [visible, setVisible] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!readDismissed()) {
      setVisible(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    persistDismissed();
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    dismissRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, dismiss]);

  if (!visible) {
    return null;
  }

  return (
    <div className="storage-modal-backdrop" onClick={dismiss}>
      <div
        className="storage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="storage-modal-title" className="storage-modal-title">
          A quick note on storage
        </p>
        <p className="storage-modal-copy">
          This site sets no cookies and runs no ad or tracking scripts. It keeps a small
          game-asset index in your browser&rsquo;s local storage so pages load faster, and
          that never leaves your device. See the <a href="/cookies">Cookie Policy</a> for the
          details.
        </p>
        <button
          ref={dismissRef}
          type="button"
          className="btn btn-primary storage-modal-dismiss"
          onClick={dismiss}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
