/**
 * Persistent Store collection names. Kept in their own import-free module so the
 * store implementations can name their collection without pulling the MongoDB
 * driver into a module that a pure in-memory test would otherwise load.
 */

export const DATABASE_NAME = 'lolprofiles';
export const RANK_SNAPSHOTS_COLLECTION = 'rank_snapshots';
export const LOOKED_UP_PLAYERS_COLLECTION = 'looked_up_players';
