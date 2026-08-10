import { createHash } from "node:crypto";

function countLeadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let i = 7; i >= 0; i -= 1) {
      if ((byte >> i) & 1) return bits;
      bits += 1;
    }
  }
  return bits;
}

/** Solve bootstrap register PoW: SHA-256(challenge_id + ":" + nonce). */
export function solveAgentRegisterPow(
  challengeId: string,
  difficulty: number,
  options?: { maxAttempts?: number },
): string {
  const target = Math.max(1, Math.floor(difficulty));
  const maxAttempts = options?.maxAttempts ?? 50_000_000;
  for (let i = 0; i < maxAttempts; i += 1) {
    const nonce = i.toString(36);
    const digest = createHash("sha256").update(`${challengeId}:${nonce}`).digest();
    if (countLeadingZeroBits(digest) >= target) return nonce;
  }
  throw new Error("Failed to solve agent register proof-of-work");
}
