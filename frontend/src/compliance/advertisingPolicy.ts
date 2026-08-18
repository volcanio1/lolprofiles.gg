/**
 * Riot ToS advertising policy.
 *
 * Implements:
 *  - 12.2: no third-party advertisement, sponsored content or paid promotional
 *    banner is displayed on any page that renders Riot data.
 *  - 12.3: WHERE a Riot-approved commercial agreement explicitly permits
 *    advertising alongside Riot API data, advertising is permitted within the
 *    scope that agreement authorizes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A CONVENTION
 * ---------------------------------------------------------------------------
 *
 * Requirement 12.2 is a prohibition, and prohibitions enforced by "remember not
 * to do this" fail eventually — a future contributor adds a banner to one page and
 * nothing objects. So the policy is inverted: `RiotDataPage` renders no ad slot
 * unless it is handed an approved agreement, and there is exactly one place in the
 * codebase where such an agreement can be introduced (`approvedAdvertisingAgreement`
 * below, hardcoded to `undefined`). Adding advertising therefore requires editing
 * this file, which is a deliberate, reviewable act rather than an oversight.
 *
 * The default is `undefined` because lolprofiles.gg operates under Riot's standard
 * Developer API terms, which do not permit it. Anyone changing this must be able
 * to point at the agreement.
 */

/**
 * Evidence of a Riot-approved commercial agreement permitting advertising
 * (Requirement 12.3). The fields exist so the override is self-documenting at the
 * point of use: an unnamed, unscoped `true` would tell a later reader nothing.
 */
export interface AdvertisingAgreement {
  /** Identifier of the agreement, for audit. */
  agreementReference: string;
  /** What the agreement authorizes, in the agreement's own terms. */
  authorizedScope: string;
}

/**
 * The single override point (Requirement 12.3). `undefined` means the default
 * Requirement 12.2 prohibition applies everywhere.
 */
export const approvedAdvertisingAgreement: AdvertisingAgreement | undefined = undefined;

/**
 * Requirement 12.2/12.3. Advertising is permitted only when an agreement is
 * present AND names a scope — an agreement object with a blank scope authorizes
 * nothing, so it is treated as absent rather than as a loophole.
 */
export function advertisingPermitted(agreement: AdvertisingAgreement | undefined): boolean {
  return agreement !== undefined && agreement.authorizedScope.trim().length > 0;
}
