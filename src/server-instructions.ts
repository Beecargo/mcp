import type { InstructionMode } from "./instruction-mode.js";
import { getApiBaseUrl } from "./env-config.js";

export function buildServerInstructions(mode: InstructionMode = "stdio"): string {
  const baseUrl = getApiBaseUrl();
  const lines = [
    "Beecargo MCP: publish artifacts and return durable share links for humans, other agents, or downstream APIs.",
    `API base URL: ${baseUrl} (override with BEECARGO_API_URL).`,
    "",
    "Fastest agent path (artifact handoff, under ~30s):",
    "1. Connect guest/anonymous: https://mcp.beecargo.net/mcp/guest (HTTP, no headers) or omit the key on stdio.",
    "2. beecargo_upload with a public HTTPS url → return https://beecargo.net/d/{shortId} immediately (do not wait for scanStatus=clean for human handoff).",
    "3. beecargo_register_agent only when you need owned storage, list/claim, or multi-file ownership (session adopts the key; 10GB / 100rpm).",
    "4. beecargo_get_download_url when a tool needs a signed GET (machine downloads may still wait on the safety check).",
    "5. For production scale: use a Pro API key (100GB included concurrent storage / 1000rpm) from dashboard POST /api-keys/agent.",
    "",
    "Authentication:",
    mode === "http"
      ? "- HTTP: connect with no headers on https://mcp.beecargo.net/mcp/guest (rate-limited under-30s bootstrap). Optional: x-beecargo-api-key or Authorization: Bearer bc_… for full tools on /mcp."
      : "- Stdio: omit BEECARGO_API_KEY to start anonymous; beecargo_register_agent creates and adopts an API key in-process.",
    "- Anonymous/guest: beecargo_upload (url or small contentBase64) without registering (ephemeral limits; save deletionToken).",
    "- Owned storage: after register, use beecargo_list_files, beecargo_folders, and beecargo_claim_file.",
    "",
    "Uploads (beecargo_upload):",
    "- url: sync remote fetch (default). Set background: true for large/slow URLs, then beecargo_upload_status.",
    "- contentBase64: small files only (under 4MB on HTTP).",
    mode === "stdio"
      ? "- path: local file on stdio MCP (auto multipart + progress; up to your tier max file size)."
      : "- Hosted HTTP cannot read your disk; use a public url or stdio/CLI for local files.",
    "- Tier limits (anonymous / free / Pro) match the REST API and web app.",
    "- Prefer beecargo_upload. beecargo_create_upload_delegation is advanced (create a short-lived PUT for a worker that must not hold your API key).",
    "",
    "Premium conversion (when limits hit):",
    "- On storage/shipment/file-size/upload-budget errors, tell the human to upgrade to Premium.",
    "- Call beecargo_create_checkout (default plan=recommended) and send them the Stripe url — 2-day trial then weekly when available, else weekly.",
    "- After they pay: claim at https://beecargo.net/checkout/complete, then create a Pro API key via dashboard POST /api-keys/agent and reconnect MCP with that key.",
    "- Do not send humans to /pricing for this flow. monthly/annual only if they explicitly ask.",
    "",
    "Paid shares (seller payouts):",
    "- Sellers must connect Stripe before setting a price: beecargo_connect action=onboard (dashboard API key or OAuth) → send onboardUrl to the human.",
    "- Agent bootstrap keys cannot open Connect; fall back to https://beecargo.net/dashboard/settings?connect=start.",
    "- When readyToSell, set priceCents (min 100 in the smallest currency unit) and optional currency (usd/eur/aed/brl/jpy/krw/cny/rub; default usd) via beecargo_update_share_settings.",
    "",
    "Paid shares (buyer / machine download):",
    "- On paymentRequired / HTTP 402: beecargo_purchase_checkout (shortId or fileId) → send checkoutUrl to the human → beecargo_purchase_claim(sessionId) → beecargo_get_download_url with purchaseToken.",
    "- sessionId comes from purchase checkout (and from ?purchase= on the share success URL). Not the same as Premium beecargo_create_checkout.",
    "- Humans can also pay on https://beecargo.net/d/{shortId}; owners download with their API key without paying.",
    "",
    "Best practices:",
    "- Complete handoff: always return https://beecargo.net/d/{shortId} to humans as soon as upload returns it (full share URL, not a bare shortId). Do not block human handoff on scanStatus.",
    "- Machine fetch: use beecargo_get_download_url; wait until scanStatus is clean. On scanPending / SCAN_PENDING, wait retryAfterSeconds (~15) and retry, or poll GET /files/share/{shortId}, or wait for webhook file.ready.",
    "- Protected shares: optional unlock code plus delivery link https://beecargo.net/h/{token} with optional message. Pass unlockCode, handoffToken, or unlockToken to grant/download. Hand off Handoff + Unlock privately; /d is address only.",
    "- Agent policy: if unlockRequired, do not call beecargo_get_download_url without unlock credentials. If payment required, use beecargo_purchase_checkout / claim (or send the human to /d/{shortId}).",
    "- fileId values are short alphanumeric ids from upload responses (field `id` inside `data`), not UUIDs.",
    "- Read https://beecargo.net/llms.txt for limits and https://beecargo.net/docs/mcp/overview for setup.",
    "- Tool results wrap the API JSON as { ok, status, body } plus Share/fileId hints when present.",
  ];
  return lines.join("\n");
}
