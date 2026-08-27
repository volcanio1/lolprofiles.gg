export {
  DDRAGON_BASE,
  buildStaticDataIndex,
  classifyCompletedItem,
  createStaticDataProvider,
  type ChampionEntry,
  type ItemEntry,
  type StaticDataIndex,
  type StaticDataProvider,
} from './provider';
export {
  STATIC_DATA_TTL_MS,
  clearStoredIndex,
  readStoredIndex,
  writeStoredIndex,
} from './cache';
export { StaticDataContext, StaticDataContextProvider, useStaticData } from './StaticDataContext';
