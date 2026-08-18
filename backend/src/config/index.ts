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

  return {
    riotApiKey,
    port,
    allowedOrigins: parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
  };
}
