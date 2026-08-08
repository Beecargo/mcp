import { looksLikeUpgradeEligibleError } from "./upgrade-eligible.js";

const SITE_ORIGIN = "https://beecargo.net";

/** Compact byte label for agent-facing limit lines (MCP has no shared dep). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Beecargo upload/download payloads use `{ success, data }` on many routes. */
function unwrapApiData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function shareLineFromPayload(body: unknown): string | null {
  const data = unwrapApiData(body);
  if (!data) return null;
  const shortId = data.shortId ?? data.short_id;
  if (typeof shortId !== "string" || !shortId) return null;
  const name = typeof data.name === "string" ? data.name : undefined;
  const sharePath =
    typeof data.sharePath === "string"
      ? data.sharePath
      : name
        ? `/d/${shortId}#${name.replace(/\s+/g, ".")}`
        : `/d/${shortId}`;
  const fileId = data.id;
  const lines = [
    `Share: ${SITE_ORIGIN}${sharePath}`,
    `Human link: ${SITE_ORIGIN}${sharePath}`,
    `Code: ${shortId} (humans can also open ${SITE_ORIGIN}/get and enter this code)`,
  ];
  const sha256 = data.sha256 ?? data.content_sha256;
  if (typeof sha256 === "string" && sha256) {
    lines.push(`sha256: ${sha256}`);
  }
  if (typeof data.agentLink === "string") {
    lines.push(`Agent link: ${data.agentLink}`);
  } else if (typeof data.agent_link === "string") {
    lines.push(`Agent link: ${data.agent_link}`);
  }
  if (typeof fileId === "string" && fileId) {
    lines.push(`fileId: ${fileId}`);
  }
  const deletionToken = data.deletionToken ?? data.deletion_token;
  if (typeof deletionToken === "string" && deletionToken) {
    lines.push(
      `deletionToken: ${deletionToken} (save this to delete anonymous uploads later)`,
    );
  }
  const unlockCode = data.unlockCode ?? data.unlock_code;
  if (typeof unlockCode === "string" && unlockCode) {
    lines.push(
      `Unlock: ${unlockCode} (required to download; share separately from the link)`,
    );
  }
  const handoffUrl = data.handoffUrl ?? data.handoff_url;
  if (typeof handoffUrl === "string" && handoffUrl) {
    lines.push(
      `Handoff: ${handoffUrl} (delivery link with your message; unlocks download for the recipient)`,
    );
  }
  return lines.join("\n");
}

function nestedErrorRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (
    record.error &&
    typeof record.error === "object" &&
    !Array.isArray(record.error)
  ) {
    return record.error as Record<string, unknown>;
  }
  return null;
}

function nestedDetails(body: unknown): Record<string, unknown> | null {
  const nested = nestedErrorRecord(body);
  if (nested?.details && typeof nested.details === "object" && nested.details) {
    return nested.details as Record<string, unknown>;
  }
  if (body && typeof body === "object") {
    return body as Record<string, unknown>;
  }
  return null;
}

/** Build Premium conversion hints for quota / product-limit failures. */
export function upgradeLinesFromPayload(body: unknown): string[] | null {
  const flat =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const nested = nestedErrorRecord(body);
  const details = nestedDetails(body);
  const message =
    (typeof flat?.error === "string" ? flat.error : null) ??
    (typeof nested?.message === "string" ? nested.message : null) ??
    undefined;

  const upgradeEligible =
    typeof details?.upgradeEligible === "boolean"
      ? details.upgradeEligible
      : typeof flat?.upgradeEligible === "boolean"
        ? flat.upgradeEligible
        : undefined;

  const limitKind = details?.limitKind ?? flat?.limitKind;

  if (
    !looksLikeUpgradeEligibleError({
      limitKind,
      upgradeEligible,
      message,
      error: message,
    })
  ) {
    return null;
  }

  const lines: string[] = [];
  if (typeof limitKind === "string" && limitKind) {
    lines.push(`Limit: ${limitKind}`);
  }
  const limitBytes =
    typeof details?.limitBytes === "number"
      ? details.limitBytes
      : typeof flat?.limitBytes === "number"
        ? flat.limitBytes
        : null;
  if (typeof limitBytes === "number" && Number.isFinite(limitBytes)) {
    lines.push(
      `Max file size for this key/account: ${formatBytes(limitBytes)}`,
    );
  }
  lines.push(
    `Upgrade: anonymous/free limits reached — send the human to Premium.`,
    `Call beecargo_create_checkout (default plan=recommended: trial if eligible else weekly) and send them the returned Stripe url.`,
    `After they pay: claim at ${SITE_ORIGIN}/checkout/complete, then mint a Pro bc_* via dashboard POST /api-keys/agent.`,
  );
  if (typeof details?.agentAdvice === "string" && details.agentAdvice) {
    lines.push(`Advice: ${details.agentAdvice}`);
  } else if (typeof flat?.agentAdvice === "string" && flat.agentAdvice) {
    lines.push(`Advice: ${flat.agentAdvice}`);
  }
  return lines;
}

/** Extra human lines for a successful beecargo_create_checkout response. */
export function checkoutLinesFromPayload(body: unknown): string[] | null {
  const data = unwrapApiData(body);
  if (!data) return null;
  const url = data.url;
  if (typeof url !== "string" || !url.startsWith("http")) return null;
  const claimUrl =
    typeof data.claimUrl === "string"
      ? data.claimUrl
      : `${SITE_ORIGIN}/checkout/complete`;
  return [
    `Checkout: ${url}`,
    `Send this Stripe link to the human to subscribe to Premium.`,
    `After payment they claim Premium at ${claimUrl}, then mint a Pro agent key in the dashboard (POST /api-keys/agent).`,
  ];
}

export function formatToolResult(
  result: { ok: boolean; status: number; body: unknown },
  extraLines?: string[],
): string {
  const parts = [
    JSON.stringify(
      { ok: result.ok, status: result.status, body: result.body },
      null,
      2,
    ),
  ];
  const share = shareLineFromPayload(result.body);
  if (share) parts.push(share);
  if (result.ok) {
    const checkout = checkoutLinesFromPayload(result.body);
    if (checkout) parts.push(checkout.join("\n"));
  } else {
    const upgrade = upgradeLinesFromPayload(result.body);
    if (upgrade) parts.push(upgrade.join("\n"));
  }
  if (extraLines?.length) parts.push(...extraLines);
  return parts.join("\n\n");
}
