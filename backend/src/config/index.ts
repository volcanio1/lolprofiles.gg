import { parseAllowedOrigins } from '../api/cors';

export interface AppConfig {
  riotApiKey: string;
  port: number;
  /**
   * Exact origins permitted to call the API cross-origin, from
   * `CORS_ALLOWED_ORIGINS` (comma-separated). Empty by default, which sends no CORS
   * headers — correct for a same-origin deployment, and for development where Vite
   * proxies `/api` through its dev server. See `api/cors.ts` for why this is an
   * allowlist rather than a wildcard.
   */
  allowedOrigins: string[];
  /**
   * The single Data Dragon release every asset URL and display name is resolved
   * against, from `DDRAGON_VERSION`. Required, and deliberately has no default:
   * a moving alias would make a Riot patch change what the site renders without
   * any deploy, and would let a cached response and a live one disagree.
   */
  dataDragonVersion: string;
  /**
   * Absolute or relative path to the built frontend (`frontend/dist`), from
   * `FRONTEND_DIST`. When set, the API process also serves the SPA with a history
   * fallback so a hard refresh of `/profile` does not 404. Unset (the default) is
   * correct when a CDN or reverse proxy serves the frontend instead.
   */
  frontendDistPath?: string;
  /**
   * How many recent match ids to fetch and detail per lookup, from
   * `MATCH_HISTORY_COUNT`. Unset uses the orchestrator's default (100), which
   * suits a production Riot key. A development key allows only 100 requests per
   * 2 minutes, so a cold lookup at 100 exhausts the budget immediately and
   * everything 429s — set this to ~30 alongside a dev key.
   */
  matchHistoryCount?: number;
  /**
   * MongoDB connection string for the persistent store (rank history + player
   * autocomplete), from `MONGODB_URI`. Optional: unset disables the persistent
   * store entirely and the site runs exactly as it did before it existed. A
   * set-but-unreachable value is logged once at startup and also runs disabled —
   * it never crashes the process. Only the string's presence is validated here;
   * the driver validates its shape.
   */
  mongodbUri?: string;
}

/** Parses a positive-integer env var, or `undefined` when unset/blank. Throws on garbage. */
function readPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} environment variable value: "${raw}". Expected a positive integer.`);
  }
  return value;
}

/**
 * Loads and validates application configuration from environment variables.
 * Never logs or exposes the Riot API key value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const riotApiKey = env.RIOT_API_KEY;

  if (!riotApiKey || riotApiKey.trim().length === 0) {
    throw new Error(
      'Missing required environment variable RIOT_API_KEY. Set it in your environment or .env file before starting the server.'
    );
  }

  const rawPort = env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : 3001;

  if (Number.isNaN(port)) {
    throw new Error(
      `Invalid PORT environment variable value: "${rawPort}". Expected a numeric port number.`
    );
  }

  const dataDragonVersion = env.DDRAGON_VERSION?.trim();

  if (!dataDragonVersion || dataDragonVersion.length === 0) {
    throw new Error(
      'Missing required environment variable DDRAGON_VERSION. Set it to an exact Data Dragon release (e.g. "16.17.1"); see https://ddragon.leagueoflegends.com/api/versions.json.'
    );
  }

  // A moving alias is rejected rather than merely undocumented. Accepting it would
  // make a Riot patch silently change every rendered asset, and would let two
  // requests seconds apart resolve to different releases.
  if (dataDragonVersion.toLowerCase() === 'latest') {
    throw new Error(
      'Invalid DDRAGON_VERSION value "latest". Pin an exact Data Dragon release (e.g. "16.17.1"); a moving alias would change rendered assets without a deploy.'
    );
  }

  const frontendDist = env.FRONTEND_DIST?.trim();
  const mongodbUri = env.MONGODB_URI?.trim();

  return {
    riotApiKey,
    port,
    allowedOrigins: parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
    dataDragonVersion,
    frontendDistPath: frontendDist && frontendDist.length > 0 ? frontendDist : undefined,
    matchHistoryCount: readPositiveInt(env.MATCH_HISTORY_COUNT, 'MATCH_HISTORY_COUNT'),
    mongodbUri: mongodbUri && mongodbUri.length > 0 ? mongodbUri : undefined,
  };
}
