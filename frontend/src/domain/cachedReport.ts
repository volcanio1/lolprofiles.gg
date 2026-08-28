/**
 * Cached-report timing constants, mirrored from `backend/src/api/cachedReport.ts`.
 *
 * PURE MODULE. No I/O, no React.
 *
 * The backend is AUTHORITATIVE — `GET /api/players/report` is what actually
 * decides whether a snapshot is fresh. These copies drive the frontend's
 * matching behaviour (the Refresh cooldown, and the "updated N ago" label's
 * sense of what counts as recent). The literal values are asserted in
 * `cachedReport.test.ts` and cross-checked against the backend source in
 * `parity.test.ts`, the same drift guard the other mirrored constants use.
 */

/** specs/autofill-search/ Requirement 9.4 — a snapshot at least this old is treated as absent. 15 days. */
export const SNAPSHOT_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

/** specs/autofill-search/ Requirement 10.4 — Refresh is disabled while the data is younger than this. 5 minutes. */
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
