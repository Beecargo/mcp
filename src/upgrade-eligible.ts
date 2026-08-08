/** Legacy message substrings that imply an upgrade-eligible limit. */
const LEGACY_UPGRADE_MESSAGE_MATCHERS = [
  /storage quota exceeded/i,
  /anonymous storage quota exceeded/i,
  /file too large/i,
  /file exceeds size limit/i,
  /file exceeds the .+ size limit/i,
  /shipment limit reached/i,
  /upload budget exceeded/i,
  /premium is required/i,
] as const;

/** Limit kinds that should prompt Premium conversion when upgradeEligible is absent. */
const UPGRADE_ELIGIBLE_LIMIT_KINDS = new Set([
  "STORAGE_QUOTA",
  "ANON_STORAGE_QUOTA",
  "FILE_SIZE",
  "SHIPMENT_QUOTA",
  "INGEST_BUDGET",
  "BUNDLE_FILE_COUNT",
  // Legacy aliases from older payloads
  "SHIPMENT_LIMIT",
  "UPLOAD_BUDGET",
  "PREMIUM_REQUIRED",
]);

/** True when an error body/message should prompt Premium conversion. */
export const looksLikeUpgradeEligibleError = (input: {
  limitKind?: unknown;
  upgradeEligible?: unknown;
  message?: unknown;
  error?: unknown;
}): boolean => {
  if (typeof input.upgradeEligible === "boolean") {
    return input.upgradeEligible;
  }
  if (
    typeof input.limitKind === "string" &&
    UPGRADE_ELIGIBLE_LIMIT_KINDS.has(input.limitKind)
  ) {
    return true;
  }
  const message =
    typeof input.message === "string"
      ? input.message
      : typeof input.error === "string"
        ? input.error
        : null;
  if (!message) return false;
  return LEGACY_UPGRADE_MESSAGE_MATCHERS.some((re) => re.test(message));
};
