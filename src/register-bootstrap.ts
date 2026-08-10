import { callBeecargoApi } from "./api-client.js";
import { solveAgentRegisterPow } from "./agent-register-pow.js";

const REGISTER_ATTEMPTS = 3;

function isRetryablePowFailure(status: number, body: unknown): boolean {
  if (status === 429) return false;
  if (status !== 400) return false;
  if (!body || typeof body !== "object") return true;
  const code = (body as { error_code?: unknown }).error_code;
  if (typeof code !== "string") return true;
  return (
    code === "pow_required" ||
    code === "invalid_challenge" ||
    code === "expired_challenge" ||
    code === "insufficient_work" ||
    code === "pow_reused" ||
    code === "ip_mismatch"
  );
}

/** Challenge + easy PoW + register, with a few fresh-challenge retries. */
export async function registerBootstrapAgent(label: string): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  let last: { ok: boolean; status: number; body: unknown } = {
    ok: false,
    status: 500,
    body: { error: "Register failed" },
  };

  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    const challenge = await callBeecargoApi({
      apiKey: null,
      method: "POST",
      path: "/agent/register/challenge",
    });
    if (!challenge.ok || !challenge.body || typeof challenge.body !== "object") {
      last = challenge;
      if (challenge.status === 429) return challenge;
      continue;
    }

    const challengeBody = challenge.body as {
      challenge_id?: string;
      difficulty?: number;
    };
    if (!challengeBody.challenge_id || typeof challengeBody.difficulty !== "number") {
      last = {
        ok: false,
        status: challenge.status,
        body: { error: "Invalid register challenge response" },
      };
      continue;
    }

    let nonce: string;
    try {
      nonce = solveAgentRegisterPow(
        challengeBody.challenge_id,
        challengeBody.difficulty,
      );
    } catch {
      // Easy difficulty should almost never fail; retry with a new challenge.
      last = {
        ok: false,
        status: 500,
        body: { error: "Failed to solve register proof-of-work" },
      };
      continue;
    }

    const result = await callBeecargoApi({
      apiKey: null,
      method: "POST",
      path: "/agent/register",
      body: {
        label,
        challenge_id: challengeBody.challenge_id,
        nonce,
      },
    });
    last = result;
    if (result.ok) return result;
    if (!isRetryablePowFailure(result.status, result.body)) return result;
  }

  return last;
}
