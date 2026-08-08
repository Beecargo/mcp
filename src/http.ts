import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  getApiBaseUrl,
  getMcpAllowedHosts,
  getMcpHttpBearerTokens,
  getMcpPublicOrigin,
  getMcpReadinessChecks,
  getOptionalApiKey,
  mcpHttpPort,
  mcpListenHost,
  mcpMaxBodyBytes,
  mcpMaxSessions,
  mcpRateLimitRpm,
  mcpRequireAuth,
  mcpSessionTtlMs,
  mcpTrustProxy,
  mcpTrustedProxyHops,
} from "./env-config.js";
import { getMcpBrandText, printMcpConsoleBrand } from "./console-brand.js";
import { createBeecargoMcpServer, type McpToolSet } from "./register-tools.js";
import { extractOAuthAccessToken, extractSessionApiKey } from "./session-api-key.js";
import { buildProtectedResourceMetadata } from "./oauth-metadata.js";
import { introspectOAuthAccessToken } from "./oauth-introspect.js";
import { merchantOAuthEnabled } from "./env-config.js";
import { McpSessionRegistry } from "./session-registry.js";

type RateBucket = { count: number; windowStart: number };

function bearerMatches(presented: string, tokens: string[]): boolean {
  const buf = Buffer.from(presented);
  for (const token of tokens) {
    const tbuf = Buffer.from(token);
    if (buf.length === tbuf.length && timingSafeEqual(buf, tbuf)) {
      return true;
    }
  }
  return false;
}

function normalizeIp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

/** Prefer CF-Connecting-IP; else rightmost trusted XFF hop; else socket peer. */
function clientIp(req: Request): string {
  if (mcpTrustProxy()) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string") {
      const normalized = normalizeIp(cf);
      if (normalized) return normalized;
    }
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const parts = forwarded
        .split(",")
        .map((part) => normalizeIp(part))
        .filter((part): part is string => Boolean(part));
      if (parts.length > 0) {
        const hops = mcpTrustedProxyHops();
        const index = Math.max(0, parts.length - hops);
        return parts[index] ?? parts[parts.length - 1]!;
      }
    }
  }
  return normalizeIp(req.socket.remoteAddress ?? "") ?? "unknown";
}

function checkMcpRateLimit(
  buckets: Map<string, RateBucket>,
  ip: string,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const rpm = mcpRateLimitRpm();
  if (rpm <= 0) return { ok: true };
  const now = Date.now();
  const windowMs = 60_000;
  let b = buckets.get(ip);
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now };
    buckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > rpm) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowMs - (now - b.windowStart)) / 1000),
    );
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

async function resolveRequestApiKey(req: Request): Promise<string | null> {
  const apiKey = extractSessionApiKey(req);
  if (apiKey) return apiKey;

  const oauthToken = extractOAuthAccessToken(req);
  if (oauthToken) {
    const intro = await introspectOAuthAccessToken(oauthToken);
    if (intro.active) return oauthToken;
  }

  return getOptionalApiKey();
}

function mcpGuestAuthMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}

async function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tokens = getMcpHttpBearerTokens();
  const auth = req.headers.authorization;
  const presented =
    auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;

  if (presented && tokens.length > 0 && bearerMatches(presented, tokens)) {
    next();
    return;
  }

  const apiKey = extractSessionApiKey(req);
  if (apiKey) {
    next();
    return;
  }

  const oauthToken = extractOAuthAccessToken(req);
  if (oauthToken) {
    const intro = await introspectOAuthAccessToken(oauthToken);
    if (intro.active) {
      next();
      return;
    }
    if (merchantOAuthEnabled()) {
      const metadataUrl = `${getMcpPublicOrigin()}/.well-known/oauth-protected-resource/mcp`;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`,
      );
      res.status(401).json({
        error: "Unauthorized",
        error_code: "invalid_oauth_token",
        message: "OAuth access token is invalid, expired, or revoked.",
      });
      return;
    }
  }

  if (!mcpRequireAuth()) {
    next();
    return;
  }

  const metadataUrl = `${getMcpPublicOrigin()}/.well-known/oauth-protected-resource/mcp`;
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
  res.status(401).json({
    error: "Unauthorized",
    error_code: presented ? "invalid_credentials" : "missing_credentials",
    message:
      "Send Authorization: Bearer bc_oat_…, bc_* API key, or transport bearer. Guest tools: /mcp/guest. See https://beecargo.net/docs/mcp/overview",
  });
}

function sessionIdFromRequest(req: Request): string | undefined {
  const sessionHeader = req.headers["mcp-session-id"];
  return Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
}

/** Browser / curl human GETs — not Streamable HTTP SSE or session resumes. */
function isHumanLandingGet(req: Request): boolean {
  if (req.method !== "GET") return false;
  if (sessionIdFromRequest(req)) return false;
  if (req.headers["mcp-protocol-version"]) return false;
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream")) return false;
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  return true;
}

function sendMcpBrandPage(res: Response): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(getMcpBrandText());
}

function maybeServeMcpLanding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isHumanLandingGet(req)) {
    sendMcpBrandPage(res);
    return;
  }
  next();
}

export function createHttpApplication(): Express {
  const registry = new McpSessionRegistry(mcpMaxSessions(), mcpSessionTtlMs());
  registry.startPeriodicPrune();
  const rateBuckets = new Map<string, RateBucket>();

  const app = express();
  const bodyLimit = mcpMaxBodyBytes();
  app.use(express.json({ limit: bodyLimit }));

  if (mcpTrustProxy()) {
    app.set("trust proxy", 1);
  }

  const listenHost = mcpListenHost();
  const allowedHosts = getMcpAllowedHosts();
  if (allowedHosts.length > 0) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    const localhostHosts = ["127.0.0.1", "localhost", "::1"];
    if (localhostHosts.includes(listenHost)) {
      app.use(localhostHostValidation());
    } else if (listenHost === "0.0.0.0" || listenHost === "::") {
      console.warn(
        `[beecargo-mcp] Binding to ${listenHost} without BEECARGO_MCP_ALLOWED_HOSTS; use TLS in production (set BEECARGO_MCP_REQUIRE_AUTH=true to require transport bearer).`,
      );
    }
  }

  function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const rl = checkMcpRateLimit(rateBuckets, clientIp(req));
    if (rl.ok) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json({
      error: "Too Many Requests",
      error_code: "rate_limited",
      message: `MCP request rate limit exceeded (${mcpRateLimitRpm()} req/min per client).`,
      retry_after_sec: rl.retryAfterSec,
    });
  }

  app.get("/", (_req, res) => {
    sendMcpBrandPage(res);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "beecargo-mcp" });
  });

  app.get("/ready", (_req, res) => {
    const readiness = getMcpReadinessChecks();
    const status = readiness.ok ? 200 : 503;
    res.status(status).json({
      ready: readiness.ok,
      service: "beecargo-mcp",
      apiUrl: getApiBaseUrl(),
      checks: readiness.checks,
      sessions: registry.size,
    });
  });

  app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (_req, res) => {
    res.json(buildProtectedResourceMetadata());
  });

  const handleMcp = async (
    req: Request,
    res: Response,
    toolSet: McpToolSet,
  ): Promise<void> => {
    try {
      const sessionId = sessionIdFromRequest(req);
      const headerKey = await resolveRequestApiKey(req);

      if (sessionId && registry.has(sessionId)) {
        registry.touch(sessionId);
        const entry = registry.get(sessionId)!;
        if (headerKey) entry.state.apiKey = headerKey;
        await entry.transport.handleRequest(
          req as IncomingMessage,
          res as ServerResponse,
          req.method === "POST" ? req.body : undefined,
        );
        return;
      }

      if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        if (!registry.canAcceptNewSession()) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "MCP session capacity reached; retry later",
            },
            id: null,
          });
          return;
        }

        const state = { apiKey: headerKey };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            registry.attach(sid, transport, state);
          },
          onsessionclosed: (sid) => {
            registry.delete(sid);
          },
        });

        const server = createBeecargoMcpServer(
          {
            getApiKey: () => state.apiKey,
            setApiKey: (key) => {
              state.apiKey = key;
            },
          },
          "http",
          toolSet,
        );
        await server.connect(transport);
        await transport.handleRequest(
          req as IncomingMessage,
          res as ServerResponse,
          req.body,
        );
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: invalid or missing MCP session",
        },
        id: null,
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  const handleAuthenticatedMcp = (req: Request, res: Response) =>
    handleMcp(req, res, "full");
  const handleGuestMcp = (req: Request, res: Response) => handleMcp(req, res, "guest");

  app.post("/mcp", rateLimitMiddleware, mcpAuthMiddleware, handleAuthenticatedMcp);
  app.get(
    "/mcp",
    rateLimitMiddleware,
    maybeServeMcpLanding,
    mcpAuthMiddleware,
    handleAuthenticatedMcp,
  );
  app.delete("/mcp", rateLimitMiddleware, mcpAuthMiddleware, handleAuthenticatedMcp);

  app.post("/mcp/guest", rateLimitMiddleware, mcpGuestAuthMiddleware, handleGuestMcp);
  app.get(
    "/mcp/guest",
    rateLimitMiddleware,
    maybeServeMcpLanding,
    mcpGuestAuthMiddleware,
    handleGuestMcp,
  );
  app.delete("/mcp/guest", rateLimitMiddleware, mcpGuestAuthMiddleware, handleGuestMcp);

  return app;
}

export async function startHttpServer(): Promise<void> {
  const app = createHttpApplication();
  const port = mcpHttpPort();
  const host = mcpListenHost();
  app.listen(port, host, () => {
    printMcpConsoleBrand();
    console.error(`[beecargo-mcp] HTTP listening on ${host}:${port}`);
  });
}
