/**
 * clash-scouting: pure display helpers for the Scouting View.
 *
 * No React, no I/O. Turns Clash's raw position/role strings and the backend's
 * already-computed insight values into the text the roster and insight panels
 * render.
 */

import type { ClashDeclaredPosition } from '../api/types';

const POSITION_LABELS: Readonly<Record<ClashDeclaredPosition, string>> = {
  UNSELECTED: 'Unselected',
  FILL: 'Fill',
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'Bottom',
  UTILITY: 'Support',
};

/** `TOP`/`JUNGLE`/`MIDDLE`/`BOTTOM`/`UTILITY`/`UNSELECTED`/`FILL` -> a title-cased display label. */
export function declaredPositionLabel(position: ClashDeclaredPosition): string {
  return POSITION_LABELS[position];
}

/** The raw `role` a `ClashRecentFormEntry`/`observedRole` carries -> the same display label, or the raw value if unrecognized. */
export function observedRoleLabel(role: string): string {
  return (POSITION_LABELS as Readonly<Record<string, string>>)[role] ?? role;
}

/** `TOP`/`JUNGLE`/... never flagged for these two declarations (Requirement 3.5). */
export function canFlagPositionMismatch(position: ClashDeclaredPosition): boolean {
  return position !== 'UNSELECTED' && position !== 'FILL';
}
