/**
 * The one place that builds a `/profile` URL from a Riot ID, so every "click
 * this player's tag to go to their profile" site does it identically. Mirrors
 * `LiveGamePage.tsx`'s pre-existing inline `profileHref`.
 */

export function profileHref(gameName: string, tagLine: string): string {
  return `/profile?riotId=${encodeURIComponent(`${gameName}#${tagLine}`)}`;
}
