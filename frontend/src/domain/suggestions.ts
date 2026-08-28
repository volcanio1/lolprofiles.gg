/**
 * Autocomplete query rules, mirrored from `backend/src/api/suggest.ts`.
 *
 * PURE MODULE. No I/O, no React, no network.
 *
 * The backend is AUTHORITATIVE — `GET /api/players/suggest` applies these same
 * checks and returns `[]` for a query that does not pass them. This copy exists
 * so the client can skip issuing a request that would come back empty anyway
 * (specs/autofill-search/ Requirement 1.5): a keystroke below the threshold, or
 * one that already contains a `#`, costs nothing.
 *
 * The literal values are asserted in `suggestions.test.ts` and cross-checked
 * against the backend source in `parity.test.ts`, the same drift guard
 * `domain/riotId.ts` uses.
 */

/** specs/autofill-search/ design.md — the shortest query that triggers a request. */
export const MIN_QUERY_LENGTH = 2;
/** specs/autofill-search/ design.md — the most suggestions returned or rendered. */
export const MAX_SUGGESTIONS = 8;

/**
 * Requirement 1.5. A query worth issuing a request for: at least
 * `MIN_QUERY_LENGTH` characters and not yet a complete Riot ID. Expects the
 * caller to have trimmed already, matching the endpoint (which trims `q` first).
 */
export function isAnswerableSuggestionQuery(query: string): boolean {
  return query.length >= MIN_QUERY_LENGTH && !query.includes('#');
}

/**
 * The `gameName` prefix to query on, taken from a raw search-field value: the
 * text up to (but not including) any `#`, trimmed. `Faker#KR` yields `Faker`;
 * the endpoint ignores everything from `#` onward (Requirement 2.5).
 */
export function namePrefixOf(rawInput: string): string {
  const hashIndex = rawInput.indexOf('#');
  return (hashIndex === -1 ? rawInput : rawInput.slice(0, hashIndex)).trim();
}
