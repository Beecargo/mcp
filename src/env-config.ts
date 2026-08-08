export function parseBearerCsvTokens(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      throw new Error("BEECARGO_MCP_BEARER_TOKEN contains duplicate token segments");
    }
    seen.add(token);
  }
  return tokens;
}

export function getApiBaseUrl(): string {
  return (
    process.env.BEECARGO_API_URL?.trim()?.replace(/\/$/, "") ||
    "https://api.beecargo.net"
  );
}

export function getOptionalApiKey(): string | null {
  const key =
    process.env.BEECARGO_API_KEY?.trim() ||
    process.env.BEECARGO_SECRET_KEY?.trim() ||
    null;
  return key && key.length > 0 ? key : null;
}

export function getMcpHttpBearerTokens(): string[] {
  return parseBearerCsvTokens(process.env.BEECARGO_MCP_BEARER_TOKEN);
}

export function mcpHttpPort(): number {
  const p = Number(process.env.PORT ?? process.env.BEECARGO_MCP_PORT ?? 3100);
  return Number.isFinite(p) ? p : 3100;
}

export function getMcpPublicOrigin(): string {
  return (
    process.env.BEECARGO_MCP_PUBLIC_URL?.trim()?.replace(/\/$/, "") ||
    "https://mcp.beecargo.net"
  );
}

export function merchantOAuthEnabled(): boolean {
  return process.env.BEECARGO_MERCHANT_OAUTH_ENABLED === "true";
}

/** When true, hosted MCP requires transport bearer or bc_* (legacy lockdown). */
export function mcpRequireAuth(): boolean {
  const raw = process.env.BEECARGO_MCP_REQUIRE_AUTH?.trim().toLowerCase();
  if (raw === "true" || raw === "on" || raw === "1") return true;
  if (raw === "false" || raw === "off" || raw === "0") return false;
  return process.env.NODE_ENV === "production";
}

export function getTransportMode(): "stdio" | "http" {
  return process.env.BEECARGO_MCP_TRANSPORT === "http" ? "http" : "stdio";
}

export function mcpMaxSessions(): number {
  const n = Number(process.env.BEECARGO_MCP_MAX_SESSIONS ?? "2000");
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

export function mcpSessionTtlMs(): number {
  const n = Number(process.env.BEECARGO_MCP_SESSION_TTL_MS ?? `${30 * 60_000}`);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

export function mcpRateLimitRpm(): number {
  const n = Number(process.env.BEECARGO_MCP_RATE_LIMIT_RPM ?? "120");
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

export function mcpMaxBodyBytes(): number {
  const n = Number(process.env.BEECARGO_MCP_MAX_BODY_BYTES ?? `${4 * 1024 * 1024}`);
  return Number.isFinite(n) && n > 0 ? n : 4 * 1024 * 1024;
}

export function mcpTrustProxy(): boolean {
  return process.env.BEECARGO_MCP_TRUST_PROXY === "true";
}

/** Rightmost X-Forwarded-For hops trusted as proxies when trust proxy is on. */
export function mcpTrustedProxyHops(): number {
  const n = Number(process.env.BEECARGO_MCP_TRUSTED_PROXY_HOPS ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function mcpListenHost(): string {
  return process.env.BEECARGO_MCP_HOST?.trim() || "0.0.0.0";
}

export function getMcpAllowedHosts(): string[] {
  const raw = process.env.BEECARGO_MCP_ALLOWED_HOSTS?.trim();
  const hosts = raw
    ? raw
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    : [];
  // Only append Railway healthcheck host when the operator opted into host allowlisting.
  if (hosts.length > 0 && process.env.RAILWAY_ENVIRONMENT) {
    hosts.push("healthcheck.railway.app");
  }
  const publicHost = (() => {
    try {
      const url = process.env.BEECARGO_MCP_PUBLIC_URL?.trim();
      return url ? new URL(url).host.toLowerCase() : "";
    } catch {
      return "";
    }
  })();
  if (publicHost && hosts.length > 0) {
    hosts.push(publicHost);
  }
  return [...new Set(hosts)];
}

export function getMcpReadinessChecks(): {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
} {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const apiUrl = getApiBaseUrl();
  checks.push({
    name: "api_url",
    ok: Boolean(apiUrl),
    detail: apiUrl ? undefined : "BEECARGO_API_URL missing",
  });

  if (mcpRequireAuth()) {
    const tokens = getMcpHttpBearerTokens();
    const transportOk = tokens.length > 0;
    checks.push({
      name: "mcp_require_auth_bearer",
      ok: transportOk,
      detail: transportOk
        ? undefined
        : "BEECARGO_MCP_BEARER_TOKEN required when BEECARGO_MCP_REQUIRE_AUTH=true",
    });
  }

  if (merchantOAuthEnabled()) {
    const internal =
      process.env.INTERNAL_API_KEY?.trim() || process.env.CRON_SECRET?.trim() || "";
    checks.push({
      name: "oauth_internal_key",
      ok: Boolean(internal),
      detail: internal
        ? undefined
        : "INTERNAL_API_KEY or CRON_SECRET required for OAuth introspection",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export function ensureProductionBearer(): void {
  if (!mcpRequireAuth()) return;
  if (getMcpHttpBearerTokens().length > 0) return;
  console.error(
    "[beecargo-mcp] FATAL: BEECARGO_MCP_BEARER_TOKEN is required when BEECARGO_MCP_REQUIRE_AUTH=true",
  );
  process.exit(1);
}
