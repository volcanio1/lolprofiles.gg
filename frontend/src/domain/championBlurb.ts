/**
 * The one-line champion blurb shown next to the name on the build page:
 * title, class, resource and Riot's difficulty rating, e.g.
 *   "The Loose Cannon · Marksman · Mana · Difficulty 6/10"
 *
 * PURE MODULE. Every field is optional — an older static-data cache entry
 * predates them — so an absent field is dropped and the parts that remain are
 * joined with " · ". Returns `''` when nothing is known, which the caller treats
 * as "render no blurb".
 */

import type { ChampionProfile } from '../staticData/provider';

/** `the Loose Cannon` -> `The Loose Cannon`; leaves an already-capitalised title alone. */
function capitalise(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

export function formatChampionBlurb(profile: ChampionProfile | null): string {
  if (profile === null) {
    return '';
  }
  const parts: string[] = [];

  const title = profile.title.trim();
  if (title.length > 0) {
    parts.push(capitalise(title));
  }

  const tags = profile.tags.filter((tag) => tag.trim().length > 0);
  if (tags.length > 0) {
    parts.push(tags.join(' / '));
  }

  const resource = profile.resource.trim();
  // "None" is Riot's value for resourceless champions (Katarina, Garen, …) —
  // there is no bar to name, so it is not worth a segment.
  if (resource.length > 0 && resource.toLowerCase() !== 'none') {
    parts.push(resource);
  }

  if (profile.info !== null && Number.isFinite(profile.info.difficulty)) {
    parts.push(`Difficulty ${String(profile.info.difficulty)}/10`);
  }

  return parts.join(' · ');
}
