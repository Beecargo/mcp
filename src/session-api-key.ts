import type { Request } from "express";
import { getMcpHttpBearerTokens } from "./env-config.js";

function firstHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value.trim() || null;
}

function isMcpTransportBearer(token: string): boolean {
  return getMcpHttpBearerTokens().includes(token);
}

function looksLikeBeecargoApiKey(token: string): boolean {
  const t = token.trim();
  return t.startsWith("bc_") && t.length >= 16;
}

export function extractSessionApiKey(req: Request): string | null {
  const headerKey =
    firstHeader(req.headers["x-beecargo-api-key"]) ??
    firstHeader(req.headers["x-api-key"]);
  if (headerKey) return headerKey;

  const auth = firstHeader(req.headers.authorization);
  if (!auth?.startsWith("Bearer ")) return null;
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer || isMcpTransportBearer(bearer)) return null;
  if (looksLikeBeecargoApiKey(bearer)) return bearer;
  return null;
}

export function extractOAuthAccessToken(req: Request): string | null {
  const auth = firstHeader(req.headers.authorization);
  if (!auth?.startsWith("Bearer ")) return null;
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer || isMcpTransportBearer(bearer)) return null;
  if (bearer.startsWith("bc_oat_")) return bearer;
  return null;
}
