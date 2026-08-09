# Beecargo MCP

Model Context Protocol server for the [Beecargo](https://beecargo.net) file hosting API.

Portable marketplace packaging (Agent Plugins 1.0 + Cursor manifest) lives in [`../agent-plugin`](../agent-plugin/README.md).

## Fastest path (agents)

Publish a durable share link with no human dashboard login:

1. Add hosted MCP with **no headers**: `https://mcp.beecargo.net/mcp` (full tools; see [`examples/cursor-http.mcp.json`](examples/cursor-http.mcp.json)). If `/mcp` requires auth, use `https://mcp.beecargo.net/mcp/guest` for bootstrap-only tools.
2. Call `beecargo_register_agent` → solves a short PoW, returns bootstrap `bc_*` (10GB / 100rpm; session adopts the key).
3. Call `beecargo_upload` with a public HTTPS `url` → hand off `https://beecargo.net/d/{shortId}` (always the full share URL). Multi-file handoff: `openShare: true` on the first file, then `shareShortId` on later uploads (same link, one unlock).
4. Optional: `beecargo_update_share_settings` with `protect: true` (+ `handoffMessage`) on `fileId` or Shipment `shortId` → return `unlockCode` and `handoffUrl` (`/h/…`) on a private channel.

For production agents (100GB included concurrent storage / 1000rpm / high remote/hr): mint a Pro-tier key via dashboard `POST /api-keys/agent` (Pro required) or operator `POST /agent/api-keys`.

Skip registration for ephemeral uploads: `beecargo_upload` works anonymously (stricter limits; save `deletionToken`).

## Tools

| Tool                             | Auth                  | Description                                                                        |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `beecargo_register_agent`        | None                  | Self-mint bootstrap `bc_*` (PoW + rate-limited)                                    |
| `beecargo_upload`                | Optional              | URL, small base64, or local path (stdio); `openShare` / `shareShortId` for growable multi-file shares |
| `beecargo_upload_status`         | Optional              | Poll async URL upload jobs                                                         |
| `beecargo_create_checkout`       | None                  | Mint Premium Stripe checkout (recommended: 2-day trial then weekly)              |
| `beecargo_purchase_checkout`     | Optional              | Mint pay link for a priced share (`shortId` / `fileId` / `bundleId`)             |
| `beecargo_purchase_claim`        | None                  | After pay: `sessionId` → `purchaseToken` for `beecargo_get_download_url`         |
| `beecargo_claim_file`            | API key               | Claim anonymous upload with `claimToken`                                           |
| `beecargo_search_tools`          | None                  | Keyword search over tools                                                          |
| `beecargo_update_share_settings` | API key               | Visibility, `priceCents`, direct, retention, `protect` / `handoffMessage` (`fileId` or `shortId`) |
| `beecargo_connect_status`        | Dashboard key / OAuth | Seller Stripe Connect readiness (`readyToSell`)                                    |
| `beecargo_connect_onboard`       | Dashboard key / OAuth | Mint Stripe Express onboarding URL (agent keys → dashboard deep link)              |
| `beecargo_connect_login_link`    | Dashboard key / OAuth | Stripe Express dashboard login URL                                                 |
| `beecargo_create_folder`         | API key               | Create folder                                                                      |
| `beecargo_list_folders`          | API key               | List folders                                                                       |
| `beecargo_get_download_url`      | None                  | Signed download URL (`unlockCode` / `unlockToken` / `handoffToken` / `purchaseToken` when needed) |
| `beecargo_file_info`             | Optional              | Metadata by short codes (`unlockRequired`)                                         |
| `beecargo_list_files`            | Required              | List owned files (`includeFolders`)                                                |
| `beecargo_run_artifacts`         | API key               | List files uploaded under the same `runId`                                         |
| `beecargo_delete_file`           | Key or deletion token | Delete file                                                                        |

### Advanced

| Tool                                | Auth    | Description                                                                                                                                              |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beecargo_create_upload_delegation` | API key | Mint a short-lived `uploadUrl` + `delegationToken` for a worker that must not hold `bc_*`. Prefer `beecargo_upload` for normal agent uploads. |

Detailed guides: [upload](https://beecargo.net/docs/mcp/upload), [upload status](https://beecargo.net/docs/mcp/upload-status), [run artifacts](https://beecargo.net/docs/mcp/run-artifacts), [upload delegation](https://beecargo.net/docs/mcp/upload-delegation), [folders](https://beecargo.net/docs/mcp/folders), [share settings](https://beecargo.net/docs/mcp/share-settings), [seller payouts](https://beecargo.net/docs/mcp/connect-payouts), and [buy a priced share](https://beecargo.net/docs/mcp/purchase).

## Stdio (local)

```bash
cd apps/mcp && pnpm build && pnpm start
```

Optional: `BEECARGO_API_KEY=bc_…` in env. After `beecargo_register_agent`, the stdio session adopts the new key automatically.

See [`examples/cursor-stdio.mcp.json`](examples/cursor-stdio.mcp.json).

## HTTP (hosted)

`https://mcp.beecargo.net/mcp` (full tools when authenticated). Guest bootstrap: `https://mcp.beecargo.net/mcp/guest`. See [`examples/cursor-http.mcp.json`](examples/cursor-http.mcp.json).

Existing key: [`examples/cursor-http-with-key.mcp.json`](examples/cursor-http-with-key.mcp.json).

Env: see [`.env.example`](.env.example). Highlights:

- `BEECARGO_API_URL`: default `https://api.beecargo.net`
- `BEECARGO_API_FETCH_TIMEOUT_MS`: raise for large sync remotes (default guidance: 300000)
- `BEECARGO_MCP_REQUIRE_AUTH`: set `true` to require transport bearer or `bc_*` on `/mcp` (default: open bootstrap, rate-limited)
- `BEECARGO_MCP_BEARER_TOKEN`: optional shared transport secret when `REQUIRE_AUTH=true`
- `BEECARGO_MERCHANT_OAUTH_ENABLED`: publish OAuth resource metadata and enable Connect with Beecargo (requires matching `INTERNAL_API_KEY` on API + MCP)

## CLI (local scripts)

Use the dedicated package [`@beecargo/cli`](../cli/README.md):

```bash
npx --yes github:Beecargo/cli upload ./artifact.zip --json
npx --yes github:Beecargo/cli remote https://example.com/file.bin --async --json
npx --yes github:Beecargo/cli share FILE_ID --price-cents 500 --key YOUR_BC_KEY
npx --yes github:Beecargo/cli download FILE_ID ./out.bin --purchase-token TOKEN
```

From the monorepo: `pnpm cli upload ./artifact.zip`. Publish flags (`--ttl`, `--protect`, …) match MCP `beecargo_upload`. `share --price-cents` / `download --purchase-token` match MCP share-settings and retrieve.

```bash
pnpm smoke:http   # MCP transport (no API)
BEECARGO_API_URL=http://localhost:3001 pnpm smoke:api   # live upload against API
```

## Parity with lomi MCP

| lomi                      | Beecargo                                             |
| ------------------------- | ---------------------------------------------------- |
| OpenAPI-generated tools   | Hand-written file tools (smaller surface)            |
| `lomi_search_tools`       | `beecargo_search_tools`                              |
| Zero-header HTTP connect  | Same (default); optional `BEECARGO_MCP_REQUIRE_AUTH` |
| `x-lomi-api-key` + OAuth  | `x-beecargo-api-key` / Bearer `bc_*` + anonymous     |
| GET/POST/DELETE `/mcp`    | Same                                                 |
| `/health`, `/ready`       | Same                                                 |
| Retries + timeout on REST | `BEECARGO_API_FETCH_*` env                           |
| Tool results              | `{ ok, status, body }` + share link hints            |
