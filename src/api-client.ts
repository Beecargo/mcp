import { getApiBaseUrl } from "./env-config.js";

type ApiCallOptions = {
  apiKey: string | null;
  method: string;
  path: string;
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
};

function fetchTimeoutMs(): number {
  const n = Number(process.env.BEECARGO_API_FETCH_TIMEOUT_MS ?? "120000");
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function fetchMaxRetries(): number {
  const n = Number(process.env.BEECARGO_API_FETCH_RETRIES ?? "2");
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 5) : 2;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function callBeecargoApi(
  options: ApiCallOptions,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = getApiBaseUrl();
  const url = `${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "beecargo-mcp/0.1.0",
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const timeoutMs = fetchTimeoutMs();
  const maxRetries = fetchMaxRetries();
  let lastStatus = 0;
  let lastBody: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* plain text */
      }
      lastStatus = res.status;
      lastBody = parsed;
      if (res.ok || !retryableStatus(res.status) || attempt === maxRetries) {
        return { ok: res.ok, status: res.status, body: parsed };
      }
    } catch (err) {
      clearTimeout(timer);
      if (attempt === maxRetries) {
        return {
          ok: false,
          status: 0,
          body: {
            success: false,
            error: err instanceof Error ? err.message : "Network request failed",
          },
        };
      }
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }

  return { ok: false, status: lastStatus, body: lastBody };
}
