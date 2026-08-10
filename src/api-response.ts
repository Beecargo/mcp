import { looksLikeUpgradeEligibleError } from "./upgrade-eligible.js";

const SITE_ORIGIN = "https://beecargo.net";

/** Compact byte label for agent-facing limit lines (MCP has no shared dep). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
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
    `shortId: ${shortId}`,
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

/** Guidance when machine download is blocked on the safety check. */
export function scanRetryLinesFromPayload(body: unknown): string[] | null {
  const flat =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const nested = nestedErrorRecord(body);
  const details = nestedDetails(body);
  const errorCode =
    (typeof nested?.errorCode === "string" ? nested.errorCode : null) ??
    (typeof flat?.errorCode === "string" ? flat.errorCode : null) ??
    (typeof details?.errorCode === "string" ? details.errorCode : null);
  const scanPending =
    details?.scanPending === true ||
    flat?.scanPending === true ||
    nested?.scanPending === true ||
    errorCode === "SCAN_PENDING";
  if (!scanPending) return null;

  const retryAfter =
    (typeof details?.retryAfterSeconds === "number"
      ? details.retryAfterSeconds
      : null) ??
    (typeof flat?.retryAfterSeconds === "number" ? flat.retryAfterSeconds : null) ??
    15;

  return [
    `Safety check: file is not downloadable yet (wait ~${retryAfter}s).`,
    "Retry beecargo_get_download_url after that delay, or poll GET /files/share/{shortId} until scanStatus is clean.",
    "Owners can also wait for webhook file.ready, then download.",
  ];
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
    lines.push(`Max file size for this key/account: ${formatBytes(limitBytes)}`);
  }
  lines.push(
    `Upgrade: anonymous/free limits reached — send the human to Premium.`,
    `Call beecargo_create_checkout (default plan=recommended: 2-day trial then weekly when available, else weekly) and send them the returned Stripe url.`,
    `After they pay: claim at ${SITE_ORIGIN}/checkout/complete, then create a Pro API key via dashboard POST /api-keys/agent.`,
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
    `After payment they claim Premium at ${claimUrl}, then create a Pro agent key in the dashboard (POST /api-keys/agent).`,
  ];
}

/** Extra human lines for paid-share purchase checkout. */
export function purchaseCheckoutLinesFromPayload(body: unknown): string[] | null {
  const data = unwrapApiData(body);
  if (!data) return null;
  const checkoutUrl = data.checkoutUrl;
  if (typeof checkoutUrl !== "string" || !checkoutUrl.startsWith("http")) {
    return null;
  }
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : null;
  const shortId = typeof data.shortId === "string" ? data.shortId : null;
  const lines = [
    `Purchase checkout: ${checkoutUrl}`,
    `Send this Stripe link to the human to pay for the share.`,
  ];
  if (sessionId) {
    lines.push(
      `Save sessionId=${sessionId} — after they pay, call beecargo_purchase_claim with it.`,
    );
  }
  if (shortId) {
    lines.push(`Share: ${SITE_ORIGIN}/d/${shortId}`);
  }
  return lines;
}

/** Extra human lines after claiming a paid-share purchase. */
export function purchaseClaimLinesFromPayload(body: unknown): string[] | null {
  const data = unwrapApiData(body);
  if (!data) return null;
  const purchaseToken = data.purchaseToken;
  if (typeof purchaseToken !== "string" || !purchaseToken) return null;
  const fileId = typeof data.fileId === "string" ? data.fileId : null;
  const bundleId = typeof data.bundleId === "string" ? data.bundleId : null;
  const lines = [
    `purchaseToken: ${purchaseToken}`,
    `Pass purchaseToken to beecargo_get_download_url (and unlock credentials if unlockRequired).`,
  ];
  if (fileId) lines.push(`fileId: ${fileId}`);
  if (bundleId) lines.push(`bundleId: ${bundleId}`);
  return lines;
}

/** Extra human lines for Connect onboard / Express login responses. */
export function connectLinkLinesFromPayload(body: unknown): string[] | null {
  const data = unwrapApiData(body);
  if (!data) return null;
  const onboardUrl = data.onboardUrl;
  if (typeof onboardUrl === "string" && onboardUrl.startsWith("http")) {
    const ready = data.readyToSell === true;
    return [
      `Connect onboarding: ${onboardUrl}`,
      `Send this Stripe link to the human to connect payouts.`,
      ready
        ? "Seller is already readyToSell — they can set priceCents on a share."
        : "After they finish, call beecargo_connect with action=status until readyToSell, then set priceCents via beecargo_update_share_settings.",
    ];
  }
  const loginUrl = data.loginUrl;
  if (typeof loginUrl === "string" && loginUrl.startsWith("http")) {
    return [
      `Stripe Express: ${loginUrl}`,
      `Send this link to the human to view payouts and bank details.`,
    ];
  }
  return null;
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
    const purchaseCheckout = purchaseCheckoutLinesFromPayload(result.body);
    if (purchaseCheckout) parts.push(purchaseCheckout.join("\n"));
    const purchaseClaim = purchaseClaimLinesFromPayload(result.body);
    if (purchaseClaim) parts.push(purchaseClaim.join("\n"));
    const connect = connectLinkLinesFromPayload(result.body);
    if (connect) parts.push(connect.join("\n"));
  } else {
    const scanRetry = scanRetryLinesFromPayload(result.body);
    if (scanRetry) parts.push(scanRetry.join("\n"));
    const upgrade = upgradeLinesFromPayload(result.body);
    if (upgrade) parts.push(upgrade.join("\n"));
  }
  if (extraLines?.length) parts.push(...extraLines);
  return parts.join("\n\n");
}
