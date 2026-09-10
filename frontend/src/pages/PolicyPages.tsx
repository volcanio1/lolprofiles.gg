/**
 * Privacy Policy and Cookie Policy — two static, indexable pages rendered in the
 * same `RiotDataPage` shell as the rest of the site so the masthead, footer and
 * Riot attribution stay consistent.
 *
 * They are kept together in one file because they describe the same facts from
 * two angles: lolprofiles.gg has no accounts, runs no third-party trackers, and
 * the only client-side storage it uses is `localStorage` (never cookies). If the
 * data practices change, both pages change in the same edit.
 *
 * `LAST_UPDATED` is the single source of truth for the "last updated" line on
 * both pages — bump it whenever the wording below changes materially.
 */

import { SEO } from '../components/SEO';
import { RiotDataPage } from '../compliance/RiotDataPage';

const LAST_UPDATED = '10 September 2026';

function LastUpdated() {
  return <p className="policy-updated">Last updated: {LAST_UPDATED}</p>;
}

export function PrivacyPolicyPage() {
  return (
    <RiotDataPage title="Privacy Policy">
      <SEO
        title="Privacy Policy"
        description="How lolprofiles.gg handles the data involved in looking up a League of Legends player: what is processed, what is stored, and what is not."
      />
      <div className="policy">
        <LastUpdated />

        <p className="lede">
          lolprofiles.gg is a stats-lookup tool for League of Legends. It has no user accounts, shows
          no advertising, and runs no third-party advertising or tracking scripts. This page explains
          the data that is involved when you use it.
        </p>

        <h2>Who runs this site</h2>
        <p>
          lolprofiles.gg is an independent, non-commercial project. It is not endorsed by or
          affiliated with Riot Games.
        </p>

        <h2>What we process</h2>
        <ul>
          <li>
            <strong>Riot IDs and search terms you enter.</strong> When you look up a player, the
            Riot ID (or champion name) is sent to our backend, which queries the Riot Games API to
            resolve the account and fetch its public match history, ranked standing, live game and
            related data. That data is already public through Riot&rsquo;s own client and API.
          </li>
          <li>
            <strong>Technical request data.</strong> Like any web server, our backend briefly sees
            your IP address and browser user-agent on each request. These are used only to apply
            rate limits, diagnose errors, and prevent abuse of the shared Riot API key. They are not
            used to build a profile of you and are not sold or shared.
          </li>
          <li>
            <strong>Aggregate usage analytics.</strong> We use Vercel Analytics, which counts page
            views and visits without cookies and without storing data that identifies you
            individually. It tells us which pages are used, not who used them.
          </li>
        </ul>

        <h2>What we store</h2>
        <ul>
          <li>
            <strong>Short-lived server caches.</strong> To stay within Riot&rsquo;s rate limits, the
            backend caches the results of recent lookups for a short period. A cached player report
            is keyed by account identifier, contains only data returned by the Riot API, and is
            overwritten or expires on its own.
          </li>
          <li>
            <strong>Local storage in your browser.</strong> The site stores a trimmed copy of
            Riot&rsquo;s static game-asset index and a note that you have dismissed the storage
            notice. See the <a href="/cookies">Cookie Policy</a> for details. This never leaves your
            device.
          </li>
          <li>
            <strong>No accounts, no history.</strong> We do not keep a record of which players you
            have looked up, and there is nothing to log in to.
          </li>
        </ul>

        <h2>Who we share data with</h2>
        <p>
          The only third parties involved are the infrastructure providers needed to run the site:
          the Riot Games API (the source of all game data), our hosting provider, and Vercel
          Analytics (cookieless, aggregate). We do not sell data and we do not share it for
          advertising.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>
            You can use the site without entering any real Riot ID — nothing is required.
          </li>
          <li>
            You can clear the site&rsquo;s local storage at any time through your browser settings;
            the site will simply re-fetch the asset index on the next visit.
          </li>
          <li>
            Because we keep no accounts, there is no stored profile to request or delete — beyond a
            short-lived server cache that expires on its own, there is nothing held about you.
          </li>
        </ul>

        <h2>Children</h2>
        <p>
          The site is not directed at children under 13 and does not knowingly collect personal
          information from them.
        </p>

        <h2>Changes</h2>
        <p>
          If this policy changes, the &ldquo;last updated&rdquo; date above will change with it.
        </p>
      </div>
    </RiotDataPage>
  );
}

export function CookiePolicyPage() {
  return (
    <RiotDataPage title="Cookie Policy">
      <SEO
        title="Cookie Policy"
        description="lolprofiles.gg sets no cookies. It uses a small amount of browser local storage for game assets and a dismissed-notice flag."
      />
      <div className="policy">
        <LastUpdated />

        <p className="lede">
          lolprofiles.gg does not set any cookies, and it does not use any third-party advertising or
          tracking cookies. It does use a small amount of your browser&rsquo;s <strong>local
          storage</strong>, which works differently from cookies: it stays on your device and is
          never sent to our servers or anyone else&rsquo;s.
        </p>

        <h2>What is stored locally</h2>
        <table className="policy-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Purpose</th>
              <th>Retention</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Static asset index</td>
              <td>
                A trimmed copy of Riot&rsquo;s Data Dragon index (champion, item and rune file
                names) so the site can render icons without re-downloading ~800&nbsp;KB on every
                visit.
              </td>
              <td>At least 24 hours, then re-fetched; replaced on each game patch.</td>
            </tr>
            <tr>
              <td>Storage-notice flag</td>
              <td>Records that you dismissed the one-time notice about local storage.</td>
              <td>Until you clear it.</td>
            </tr>
            <tr>
              <td>Graphics-check result</td>
              <td>
                Records that the animated landing-page background ran too slowly on this device,
                so it stays off and the static background is used instead.
              </td>
              <td>Re-checked after 30 days.</td>
            </tr>
          </tbody>
        </table>

        <h2>Analytics</h2>
        <p>
          We use Vercel Analytics to count page views and visits. It is{' '}
          <strong>cookieless</strong> and does not store data on your device or identify you
          individually.
        </p>

        <h2>How to remove it</h2>
        <p>
          Clearing site data for lolprofiles.gg in your browser settings removes everything above.
          The site keeps working; it just rebuilds the asset index on your next visit. Blocking
          local storage entirely also works — the site falls back to fetching the asset index each
          time.
        </p>

        <p>
          See the <a href="/privacy">Privacy Policy</a> for the fuller picture of what data the site
          processes.
        </p>
      </div>
    </RiotDataPage>
  );
}
