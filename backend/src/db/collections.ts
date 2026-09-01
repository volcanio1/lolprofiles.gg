/**
 * Persistent Store collection names. Kept in their own import-free module so the
 * store implementations can name their collection without pulling the MongoDB
 * driver into a module that a pure in-memory test would otherwise load.
 */

export const DATABASE_NAME = 'lolprofiles';
export const RANK_SNAPSHOTS_COLLECTION = 'rank_snapshots';
/**
 * recent-matches-lp-delta: a rank observation recorded on EVERY fresh lookup
 * (no once-per-day dedup, unlike `rank_snapshots`), for every ranked queue the
 * player has an entry in. Used only to bracket an individual ranked match's LP
 * gain/loss between two checkpoints — see `insight/lpDelta.ts`.
 */
export const RANK_CHECKPOINTS_COLLECTION = 'rank_checkpoints';
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

/**
 * specs/match-cache/ Requirement 1/7: a persistent, restart-surviving tier for
 * match details, keyed by `matchId`. One document serves every player in the
 * game.
 */
export const MATCH_DETAILS_COLLECTION = 'match_details';

/**
 * specs/match-cache/ Requirement 7.1. A STORAGE BOUND ONLY — a completed match is
 * immutable, so an expired-and-re-fetched document is byte-identical and the
 * read path applies no age check of its own (Requirement 7.2). 150 days.
 */
export const MATCH_DETAIL_TTL_SECONDS = 150 * 24 * 60 * 60;
