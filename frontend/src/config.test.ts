import { describe, expect, it } from 'vitest';
import { apiBaseUrl } from './config';

/**
 * The API base URL is the setting that decides whether the browser makes a
 * same-origin or a cross-origin request, so it is worth asserting rather than
 * assuming — a cross-origin default is what made every request fail the CORS
 * preflight before task 18.
 */

describe('apiBaseUrl', () => {
  it('defaults to a relative (same-origin) base', () => {
    // No VITE_API_BASE_URL is set in the test environment, so this is the default.
    // An absolute default such as http://localhost:3001 would make every request
    // cross-origin and be blocked by the browser unless CORS were opened.
    expect(apiBaseUrl).toBe('');
  });

  it('composes into a same-origin path', () => {
    expect(`${apiBaseUrl}/api/lookup`).toBe('/api/lookup');
  });

  it('never points at Riot directly', () => {
    // Requirement 4.2: the browser talks only to our own backend.
    expect(apiBaseUrl).not.toContain('riotgames');
  });
});
