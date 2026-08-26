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

  return {
    riotApiKey,
    port,
    allowedOrigins: parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
    dataDragonVersion,
  };
}
