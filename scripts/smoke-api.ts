/**
 * Calls the live Beecargo API through MCP tool logic (remote upload smoke).
 * Usage: BEECARGO_API_URL=http://localhost:3001 tsx scripts/smoke-api.ts
 */
import { callBeecargoApi } from "../src/api-client.js";
import { formatToolResult } from "../src/api-response.js";

const SAMPLE_URL =
  process.env.BEECARGO_SMOKE_REMOTE_URL ??
  "https://raw.githubusercontent.com/github/explore/main/topics/python/python.png";

async function main(): Promise<void> {
  const health = await callBeecargoApi({
    apiKey: null,
    method: "GET",
    path: "/health",
  });
  if (!health.ok) {
    throw new Error(
      `API health check failed (${health.status}): ${JSON.stringify(health.body)}`,
    );
  }

  const register = await callBeecargoApi({
    apiKey: null,
    method: "POST",
    path: "/agent/register",
    body: { label: "smoke-api" },
  });
  if (!register.ok) {
    throw new Error(
      `agent register failed (${register.status}): ${JSON.stringify(register.body)}`,
    );
  }
  const regBody = register.body as { key?: string };
  if (!regBody.key?.startsWith("bc_")) {
    throw new Error("agent register missing bc_* key");
  }

  const upload = await callBeecargoApi({
    apiKey: regBody.key,
    method: "POST",
    path: "/files/remote-upload",
    body: { url: SAMPLE_URL },
  });

  console.log(formatToolResult(upload));

  if (!upload.ok) {
    throw new Error("remote-upload smoke failed");
  }

  const body = upload.body as { success?: boolean; data?: { id?: string } };
  if (!body?.success || !body.data?.id) {
    throw new Error("remote-upload response missing success/data.id");
  }

  const info = await callBeecargoApi({
    apiKey: null,
    method: "GET",
    path: `/files/download/${encodeURIComponent(body.data.id)}`,
  });
  if (!info.ok) {
    throw new Error(`download smoke failed: ${JSON.stringify(info.body)}`);
  }

  console.log("smoke-api: ok");
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
