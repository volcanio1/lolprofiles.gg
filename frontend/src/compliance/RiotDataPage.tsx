/**
 * Page template for any page that renders Riot data.
 *
 * Implements:
 *  - 12.1: the required attribution statement appears on the page, verbatim.
 *  - 12.2: no ad, sponsored-content or paid-promotion slot is rendered by default.
 *  - 12.3: an approved commercial agreement may enable an advertising slot.
 *
 * Requirement 12.1 says the attribution must appear WHILE a page displays Riot
 * data, so it is attached to the template rather than to the report component:
 * a page that shows an error, a loading state, or a stale cached report is still a
 * page in the business of displaying Riot data, and the statement must not blink
 * in and out as the state changes.
 */

import type { ReactNode } from 'react';
import {
  advertisingPermitted,
  approvedAdvertisingAgreement,
  type AdvertisingAgreement,
} from './advertisingPolicy';

/**
 * Requirement 12.1's statement, verbatim. Held as a constant so the wording is
 * asserted in one place and cannot drift through JSX reformatting.
 */
export const RIOT_ATTRIBUTION_TEXT =
  "lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.";

export interface RiotDataPageProps {
  /** Accessible page title, rendered as the `h1`. */
  title: string;
  children: ReactNode;
  /**
   * Requirement 12.3's override. Defaults to the single module-level agreement,
   * which is `undefined` under Riot's standard terms. Injectable so the exception
   * path is testable without editing the policy module.
   */
  advertisingAgreement?: AdvertisingAgreement | undefined;
}

export function RiotDataPage({ title, children, advertisingAgreement }: RiotDataPageProps) {
  const agreement = advertisingAgreement ?? approvedAdvertisingAgreement;
  const adsAllowed = advertisingPermitted(agreement);

  return (
    <main>
      <h1>{title}</h1>

      {children}

      {/*
        Requirement 12.2: this branch is the ONLY place the application can render
        an advertising slot, and it is unreachable without an approved agreement.
      */}
      {adsAllowed && agreement !== undefined ? (
        <aside aria-label="Advertisement" data-testid="advertising-slot">
          <p>Advertising slot authorized by agreement {agreement.agreementReference}.</p>
        </aside>
      ) : null}

      {/* Requirement 12.1 */}
      <footer>
        <p data-testid="riot-attribution">{RIOT_ATTRIBUTION_TEXT}</p>
      </footer>
    </main>
  );
}
