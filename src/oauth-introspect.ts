import { getApiBaseUrl, merchantOAuthEnabled } from "./env-config.js";

const CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: McpIntrospectionResult;
};

export type McpIntrospectionResult =
  | { active: false }
  | {
      active: true;
      scope: string;
      sub: string;
      client_id: string;
      grant_id: string;
      exp: number;
      resource?: string | null;
    };

const cache = new Map<string, CacheEntry>();

function internalApiKey(): string | null {
  return (
    process.env.INTERNAL_API_KEY?.trim() || process.env.CRON_SECRET?.trim() || null
  );
}

export async function introspectOAuthAccessToken(
  token: string,
): Promise<McpIntrospectionResult> {
  if (!merchantOAuthEnabled() || !token.startsWith("bc_oat_")) {
    return { active: false };
  }

  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const key = internalApiKey();
  if (!key) {
    return { active: false };
  }

  const apiBase = getApiBaseUrl();
  const res = await fetch(`${apiBase}/oauth/introspect/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": key,
    },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    return { active: false };
  }

  const body = (await res.json()) as McpIntrospectionResult;
  if (!body.active) {
    cache.set(token, { expiresAt: Date.now() + 5_000, value: body });
    return body;
  }

  const ttl = Math.min(CACHE_TTL_MS, Math.max(5_000, body.exp * 1000 - Date.now()));
  cache.set(token, { expiresAt: Date.now() + ttl, value: body });
  return body;
}

export function clearOAuthIntrospectionCache(token?: string): void {
  if (token) cache.delete(token);
  else cache.clear();
}
