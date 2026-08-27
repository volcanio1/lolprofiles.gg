/**
 * 404 page — the catch-all route (`*`).
 *
 * Reached two ways: a browser router path that matches no route (a dead link, a
 * typo), or a hard refresh of any URL once the server's history fallback has
 * served the app shell (see `backend/src/app.ts`). Either way the job is the
 * same — get a lost visitor back to searching without a dead end.
 *
 * The whole product is a resolver: it takes a Riot ID and works out the PUUID and
 * platform, with nothing for the visitor to pick. So this renders the miss in
 * that same idiom — a short "trace" showing the path that was asked for and the
 * result — rather than a generic oversized "404".
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { RiotDataPage } from '../compliance/RiotDataPage';

/** Keep a pathological address bar from stretching the card. */
function shortenPath(pathname: string): string {
  const clean = pathname || '/';
  return clean.length > 42 ? `${clean.slice(0, 41)}…` : clean;
}

/** React Router stamps a monotonic `idx` into history state; 0 means this is the
 *  entry point (a direct load / hard refresh), so there is nowhere to go back to. */
function hasHistoryToReturnTo(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

export function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = hasHistoryToReturnTo();

  return (
    <RiotDataPage title="No match" hero>
      <p className="notfound-headline">This route won&rsquo;t resolve.</p>
      <p className="lede">
        The page you asked for isn&rsquo;t one we have. Search a player to pick up where you meant to
        be.
      </p>

      <dl className="notfound-trace" aria-label="What went wrong">
        <div className="notfound-trace-row">
          <dt>Path</dt>
          <dd>{shortenPath(location.pathname)}</dd>
        </div>
        <div className="notfound-trace-row">
          <dt>Result</dt>
          <dd>
            <span className="notfound-code">404</span> no route matches
          </dd>
        </div>
      </dl>

      <div className="notfound-actions">
        <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
          Search a player
        </button>
        {canGoBack ? (
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
            Go back
          </button>
        ) : null}
      </div>
    </RiotDataPage>
  );
}
