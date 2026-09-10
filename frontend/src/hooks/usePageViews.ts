/**
 * Sends a GA4 `page_view` on first render and on every client-side navigation.
 *
 * GA's automatic page_view is turned off in `index.html` (`send_page_view:
 * false`) because it only fires on a full document load — useless for a SPA
 * that swaps routes without one. This hook is the replacement.
 *
 * Only the pathname is sent: `/profile` and `/live` URLs carry a player's Riot
 * ID in the query string, which must not reach an analytics report.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPageView } from '../analytics';

export function usePageViews(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    trackPageView(pathname);
  }, [pathname]);
}
