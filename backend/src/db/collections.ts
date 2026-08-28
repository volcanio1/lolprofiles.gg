/**
 * Persistent Store collection names. Kept in their own import-free module so the
 * store implementations can name their collection without pulling the MongoDB
 * driver into a module that a pure in-memory test would otherwise load.
 */

export const DATABASE_NAME = 'lolprofiles';
export const RANK_SNAPSHOTS_COLLECTION = 'rank_snapshots';
export const LOOKED_UP_PLAYERS_COLLECTION = 'looked_up_players';

/**
 * specs/autofill-search/ Requirement 8: the most recent full `ProfileReport` per
 * player, keyed by PUUID, served instantly to a dropdown selection.
 */
export const PROFILE_REPORTS_COLLECTION = 'profile_reports';

/**
 * specs/autofill-search/ Requirement 8.8 / 9.4. A Report_Snapshot older than this
 * is treated as absent, and the database reclaims it via a TTL index. 15 days.
 * `SNAPSHOT_MAX_AGE_MS` (the endpoint's own age check) is derived from this.
 */
export const PROFILE_REPORT_TTL_SECONDS = 15 * 24 * 60 * 60;
