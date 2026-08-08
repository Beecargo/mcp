/**
 * Smoke test: MCP HTTP initializes and lists tools (no live API unless BEECARGO_API_URL is set).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApplication } from "../src/http.js";

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown; isError?: boolean };
  const rawContent = r.content;
  if (!Array.isArray(rawContent)) return "";
  return rawContent
    .map((c: { type?: string; text?: string }) =>
      c && typeof c === "object" && "text" in c ? String(c.text) : "",
    )
    .join("");
}

async function main(): Promise<void> {
  const app = createHttpApplication();
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  for (const path of ["/health", "/ready"]) {
    const res = await fetch(`${origin}${path}`);
    if (!res.ok) {
      throw new Error(`smoke: GET ${path} expected 200, got ${res.status}`);
    }
  }

  for (const path of ["/", "/mcp", "/mcp/guest"]) {
    const brand = await fetch(`${origin}${path}`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!brand.ok) {
      throw new Error(`smoke: GET ${path} brand expected 200, got ${brand.status}`);
    }
    const ct = brand.headers.get("content-type") ?? "";
    if (!ct.includes("text/plain")) {
      throw new Error(`smoke: GET ${path} expected text/plain, got ${ct}`);
    }
    const body = await brand.text();
    if (!body.includes("▲") || !body.includes("mcp.beecargo.net/mcp")) {
      throw new Error(`smoke: GET ${path} missing MCP brand page content`);
    }
  }

  const jsonProbe = await fetch(`${origin}/mcp`, {
    headers: { Accept: "application/json" },
  });
  const jsonCt = jsonProbe.headers.get("content-type") ?? "";
  if (jsonCt.includes("text/plain")) {
    throw new Error("smoke: JSON Accept GET /mcp must not return brand text/plain");
  }

  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));

  const client = new Client({ name: "beecargo-mcp-smoke", version: "0.0.1" });
  await client.connect(transport);

  const listed = await client.listTools();
  if (!listed.tools?.length) {
    throw new Error("Expected non-empty tools list");
  }

  const fullRequired = [
    "beecargo_upload",
    "beecargo_upload_status",
    "beecargo_register_agent",
    "beecargo_search_tools",
    "beecargo_claim_file",
    "beecargo_list_files",
    "beecargo_delete_file",
    "beecargo_update_share_settings",
    "beecargo_run_artifacts",
    "beecargo_create_checkout",
  ];
  for (const name of fullRequired) {
    if (!listed.tools.some((t) => t.name === name)) {
      throw new Error(`smoke: missing tool ${name}`);
    }
  }

  const forbidden = [
    "beecargo_remote_upload",
    "beecargo_upload_file",
    "beecargo_multipart_init",
  ];
  for (const name of forbidden) {
    if (listed.tools.some((t) => t.name === name)) {
      throw new Error(`smoke: legacy tool still exposed: ${name}`);
    }
  }

  const search = await client.callTool({
    name: "beecargo_search_tools",
    arguments: { query: "upload", limit: 10 },
  });
  const rawContent = search.content;
  const searchText = Array.isArray(rawContent)
    ? rawContent
        .map((c: { type?: string; text?: string }) =>
          c && typeof c === "object" && "text" in c ? String(c.text) : "",
        )
        .join("")
    : "";
  if (!searchText?.includes("beecargo_upload")) {
    throw new Error("beecargo_search_tools returned unexpected payload");
  }
  if (searchText.includes("beecargo_create_upload_delegation")) {
    throw new Error(
      "smoke: upload search should demote beecargo_create_upload_delegation",
    );
  }

  const delegationSearch = await client.callTool({
    name: "beecargo_search_tools",
    arguments: { query: "delegation", limit: 5 },
  });
  const delegationText = Array.isArray(delegationSearch.content)
    ? delegationSearch.content
        .map((c: { type?: string; text?: string }) =>
          c && typeof c === "object" && "text" in c ? String(c.text) : "",
        )
        .join("")
    : "";
  if (!delegationText.includes("beecargo_create_upload_delegation")) {
    throw new Error(
      "smoke: delegation search should surface beecargo_create_upload_delegation",
    );
  }

  const guestClient = new Client({
    name: "beecargo-mcp-guest-smoke",
    version: "0.0.1",
  });
  await guestClient.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp/guest`)),
  );
  const guestListed = await guestClient.listTools();
  const guestExpected = [
    "beecargo_register_agent",
    "beecargo_search_tools",
    "beecargo_upload",
    "beecargo_upload_status",
    "beecargo_create_checkout",
  ].sort();
  const guestActual = guestListed.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(guestActual) !== JSON.stringify(guestExpected)) {
    throw new Error(`smoke: unexpected guest tools ${JSON.stringify(guestActual)}`);
  }
  await guestClient.close();

  const apiUrl = process.env.BEECARGO_API_URL?.trim();
  if (apiUrl) {
    const reg = await client.callTool({
      name: "beecargo_register_agent",
      arguments: { label: "mcp-smoke" },
    });
    const regText = toolResultText(reg);
    if (
      ("isError" in reg && reg.isError) ||
      (!regText.includes('"ok": true') && !regText.includes('"ok":true'))
    ) {
      throw new Error(`beecargo_register_agent failed: ${regText.slice(0, 500)}`);
    }
    if (!regText.includes("bc_")) {
      throw new Error("register_agent response missing bc_* key hint");
    }

    const owned = await client.callTool({
      name: "beecargo_list_files",
      arguments: { limit: 1 },
    });
    const ownedText = toolResultText(owned);
    if (
      ("isError" in owned && owned.isError) ||
      ownedText.includes("Missing API key")
    ) {
      throw new Error(
        `registered session did not adopt the API key: ${ownedText.slice(0, 500)}`,
      );
    }
  }

  await client.close();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  console.log(`smoke-http: ok (${listed.tools.length} tools)`);
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
