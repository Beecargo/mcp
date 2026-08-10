import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callBeecargoApi } from "./api-client.js";
import { registerBootstrapAgent } from "./register-bootstrap.js";
import { formatToolResult } from "./api-response.js";
import type { InstructionMode } from "./instruction-mode.js";
import { pollRemoteJob, runBeecargoUpload, uploadInputSchema } from "./upload-mcp.js";
import { buildServerInstructions } from "./server-instructions.js";

const FILE_ID = z
  .string()
  .min(8)
  .max(64)
  .describe("File id from upload response (`data.id`), not a UUID");

type ToolContext = {
  getApiKey: () => string | null;
  setApiKey?: (key: string) => void;
};

const TOOL_CATALOG = [
  {
    name: "beecargo_register_agent",
    summary: "Self-register and get an API key (tight limits)",
  },
  {
    name: "beecargo_claim_file",
    summary: "Claim anonymous upload with claimToken (requires API key)",
  },
  {
    name: "beecargo_upload",
    summary: "Upload via URL, inline base64, or local path (stdio)",
  },
  {
    name: "beecargo_upload_status",
    summary: "Poll async URL upload job started by beecargo_upload",
  },
  {
    name: "beecargo_create_folder",
    summary: "Create a folder (API key)",
  },
  {
    name: "beecargo_list_folders",
    summary: "List folders (API key)",
  },
  {
    name: "beecargo_get_download_url",
    summary: "Signed download URL by fileId",
  },
  { name: "beecargo_file_info", summary: "Metadata by short codes" },
  {
    name: "beecargo_list_files",
    summary: "List owned files; includeFolders optional",
  },
  {
    name: "beecargo_update_share_settings",
    summary: "Set visibility, price, direct, retention, expiry on owned file",
  },
  {
    name: "beecargo_connect_status",
    summary: "Seller payout readiness (Stripe Connect status)",
  },
  {
    name: "beecargo_connect_onboard",
    summary: "Mint Stripe Connect onboarding URL for the seller",
  },
  {
    name: "beecargo_connect_login_link",
    summary: "Open Stripe Express dashboard login URL",
  },
  { name: "beecargo_delete_file", summary: "Delete by fileId + optional token" },
  {
    name: "beecargo_run_artifacts",
    summary: "List files uploaded under a runId (pipeline manifest)",
  },
  {
    name: "beecargo_create_upload_delegation",
    summary:
      "Advanced: create a short-lived upload for a worker that must not hold your API key. Prefer beecargo_upload.",
  },
  {
    name: "beecargo_create_checkout",
    summary: "Create Premium Stripe checkout (trial if eligible, else weekly)",
  },
  {
    name: "beecargo_purchase_checkout",
    summary: "Mint pay link for a priced share (buyer)",
  },
  {
    name: "beecargo_purchase_claim",
    summary: "Exchange paid sessionId for purchaseToken",
  },
  // Rill accept rail — re-enable when Rill engine is product-ready:
  // beecargo_rill_upgrade_offer, beecargo_claim_rill_upgrade
  { name: "beecargo_search_tools", summary: "Search available MCP tools" },
] as const;

const CONNECT_DASHBOARD_FALLBACK =
  "https://beecargo.net/dashboard/settings?connect=start";

const IDEMPOTENCY_KEY = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe("Optional Idempotency-Key for safe write retries");

export const GUEST_MCP_TOOL_NAMES = new Set<string>([
  "beecargo_register_agent",
  "beecargo_upload",
  "beecargo_upload_status",
  "beecargo_create_checkout",
  "beecargo_purchase_checkout",
  "beecargo_purchase_claim",
  "beecargo_search_tools",
]);

/** Hidden from beecargo_search_tools unless the query mentions delegation. */
const SEARCH_DEMOTE_UNLESS_DELEGAT = new Set<string>([
  "beecargo_create_upload_delegation",
]);

export type McpToolSet = "full" | "guest";

function missingKeyResult(
  hint = "register with beecargo_register_agent or set x-beecargo-api-key",
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Missing API key: ${hint}.`,
      },
    ],
    isError: true,
  };
}

export function createBeecargoMcpServer(
  ctx: ToolContext,
  mode: InstructionMode = "stdio",
  toolSet: McpToolSet = "full",
): McpServer {
  const server = new McpServer(
    {
      name: "beecargo",
      version: "0.1.0",
      title: "Beecargo",
      websiteUrl: "https://beecargo.net",
      icons: [
        {
          src: "https://beecargo.net/logo_bg.png",
          mimeType: "image/png",
          sizes: ["1112x1112"],
        },
      ],
    },
    { instructions: buildServerInstructions(mode) },
  );

  const registerTool: McpServer["registerTool"] = ((name, config, handler) => {
    if (toolSet === "guest" && !GUEST_MCP_TOOL_NAMES.has(name)) {
      return;
    }
    return server.registerTool(name, config, handler);
  }) as McpServer["registerTool"];

  registerTool(
    "beecargo_search_tools",
    {
      title: "Search Beecargo MCP tools",
      description:
        "Keyword search over available Beecargo tools (similar to lomi_search_tools).",
      inputSchema: z.object({
        query: z.string().optional().default(""),
        limit: z.number().int().min(1).max(20).optional().default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const q = query.trim().toLowerCase();
      const wantsDelegation = /delegat/i.test(q);
      const catalog =
        toolSet === "guest"
          ? TOOL_CATALOG.filter((t) => GUEST_MCP_TOOL_NAMES.has(t.name))
          : TOOL_CATALOG;
      const matches = catalog
        .filter((t) => {
          if (SEARCH_DEMOTE_UNLESS_DELEGAT.has(t.name) && !wantsDelegation) {
            return false;
          }
          return !q || t.name.includes(q) || t.summary.toLowerCase().includes(q);
        })
        .slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ query, tools: matches }, null, 2),
          },
        ],
      };
    },
  );

  registerTool(
    "beecargo_register_agent",
    {
      title: "Register agent API key",
      description:
        "Create an API key for agent file storage (free-tier quotas). No API key required beforehand. Solves a short proof-of-work and is rate-limited per IP. For production agents with 100GB included concurrent storage/1000rpm, create a Pro key via dashboard POST /api-keys/agent. After success, this MCP session adopts the key.",
      inputSchema: z.object({
        label: z.string().max(120).optional().describe("Optional key label"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ label }) => {
      const result = await registerBootstrapAgent(label ?? "mcp-agent");
      if (result.ok && result.body && typeof result.body === "object") {
        const key = (result.body as { key?: string }).key;
        if (key && ctx.setApiKey) {
          ctx.setApiKey(key);
        }
      }
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_create_checkout",
    {
      title: "Create Premium checkout link",
      description:
        "Create a Stripe Checkout URL for a human to subscribe to Premium. Default plan=recommended: 2-day intro ($0.90) then weekly — for agent/guest sessions and for signed-in humans who still have the intro. Falls back to weekly when the intro was already used. Prefer recommended; use weekly/monthly/annual only if the human asks. No API key required for guest checkout — do not send the session API key for guest checkout. Send the returned url to the human. After pay + claim at /checkout/complete, create a Pro API key via dashboard POST /api-keys/agent.",
      inputSchema: z.object({
        plan: z
          .enum(["recommended", "weekly", "monthly", "annual"])
          .default("recommended")
          .describe(
            "recommended = 2-day trial then weekly when available, else weekly (default). weekly/monthly/annual only if the human asks.",
          ),
        locale: z
          .enum(["en", "fr", "es", "de", "pt", "ar", "zh", "ja", "ko", "ru"])
          .optional()
          .describe(
            "Human language preference — presents Checkout in that language and charges the matching currency (usd/eur/brl/aed/cny/jpy/krw/rub).",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ plan, locale }) => {
      // Guest mint must omit Bearer — agent bc_* machine emails cannot use logged-in checkout.
      // recommended + no key → trial (2 days → weekly) via guest checkout.
      const result = await callBeecargoApi({
        apiKey: null,
        method: "POST",
        path: "/billing/checkout",
        body: { plan, ...(locale ? { locale } : {}) },
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_purchase_checkout",
    {
      title: "Pay for a priced share",
      description:
        "Create a Stripe Checkout URL so a human can pay for a priced Beecargo share (one-time file/shipment purchase — not Premium). Pass shortId and/or fileId/bundleId. Send checkoutUrl to the human. After they pay, call beecargo_purchase_claim with sessionId, then beecargo_get_download_url with the returned purchaseToken. No API key required. Owners cannot buy their own share.",
      inputSchema: z.object({
        shortId: z
          .string()
          .min(4)
          .max(16)
          .optional()
          .describe("Share shortId from /d/{shortId}"),
        fileId: FILE_ID.optional().describe("Priced file id when known"),
        bundleId: z
          .string()
          .min(8)
          .max(64)
          .optional()
          .describe("Priced bundle/shipment id when known"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ shortId, fileId, bundleId }) => {
      if (!shortId && !fileId && !bundleId) {
        return {
          content: [
            {
              type: "text",
              text: "Pass shortId and/or fileId or bundleId for the priced share.",
            },
          ],
          isError: true,
        };
      }
      const result = await callBeecargoApi({
        // Optional key associates buyer_user_id; not required for guest pay.
        apiKey: ctx.getApiKey(),
        method: "POST",
        path: "/purchases/checkout",
        body: {
          ...(shortId ? { shortId } : {}),
          ...(fileId ? { fileId } : {}),
          ...(bundleId ? { bundleId } : {}),
        },
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_purchase_claim",
    {
      title: "Claim purchase token after pay",
      description:
        "After a human pays via beecargo_purchase_checkout (or the /d/{shortId} pay flow), exchange the Stripe Checkout sessionId for a purchaseToken. Pass that token to beecargo_get_download_url. No API key required. sessionId is returned by purchase checkout and also appears as ?purchase= on the share success URL.",
      inputSchema: z.object({
        sessionId: z
          .string()
          .min(8)
          .describe(
            "Stripe Checkout session id (cs_…) from purchase checkout or ?purchase= on the share URL",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ sessionId }) => {
      const result = await callBeecargoApi({
        apiKey: null,
        method: "POST",
        path: "/purchases/claim",
        body: { sessionId },
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  // Rill agent Premium upgrade tools — parked until Rill is product-ready.
  // API remains at GET/POST /agent/rill-upgrade (env-gated). Re-register:
  // beecargo_rill_upgrade_offer → GET /agent/rill-upgrade
  // beecargo_claim_rill_upgrade → POST /agent/rill-upgrade { receipt_id }

  registerTool(
    "beecargo_claim_file",
    {
      title: "Claim anonymous file",
      description:
        "Attach an anonymous upload to your API key using fileId and claimToken from upload response.",
      inputSchema: z.object({
        fileId: FILE_ID,
        claimToken: z.string().min(8).describe("claimToken from upload response"),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ fileId, claimToken, idempotencyKey }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      const result = await callBeecargoApi({
        apiKey,
        method: "POST",
        path: "/files/claim",
        body: { fileId, claimToken },
        idempotencyKey,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_upload",
    {
      title: "Upload a file",
      description:
        "One upload tool: public url (sync or background job), contentBase64 (small), or path on stdio (auto multipart). Anonymous, free, and Pro limits match the API. Returns share link and fileId. For multi-file handoffs: openShare: true on the first file, then shareShortId on later uploads to grow the same /d link (one unlock).",
      inputSchema: uploadInputSchema(mode),
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => {
      const result = await runBeecargoUpload({
        mode,
        apiKey: ctx.getApiKey(),
        input,
        onProgress: async (p) => {
          if (extra._meta?.progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: extra._meta.progressToken,
              progress: p.progress,
              total: p.total,
              message: p.message,
            },
          });
        },
      });
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      };
    },
  );

  registerTool(
    "beecargo_upload_status",
    {
      title: "Background upload status",
      description:
        "Poll an async URL upload job from beecargo_upload (background: true). Returns sharePath when completed.",
      inputSchema: z.object({
        jobId: z.string().uuid(),
        jobSecret: z
          .string()
          .optional()
          .describe("Secret from beecargo_upload when background is true"),
        waitSeconds: z.number().int().min(0).max(600).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ jobId, jobSecret, waitSeconds }, extra) => {
      const polled = await pollRemoteJob({
        apiKey: ctx.getApiKey(),
        jobId,
        jobSecret,
        waitSeconds,
        onProgress: async (message) => {
          if (extra._meta?.progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken: extra._meta.progressToken,
              progress: 0,
              total: 1,
              message,
            },
          });
        },
      });
      return {
        content: [{ type: "text", text: polled.text }],
        isError: !polled.ok,
      };
    },
  );

  registerTool(
    "beecargo_connect_status",
    {
      title: "Seller payout status",
      description:
        "Check whether the signed-in seller can accept paid-share payments (Stripe Connect). Requires a dashboard API key or OAuth — not an agent bootstrap key. readyToSell must be true before setting priceCents.",
      inputSchema: z.object({
        sync: z.boolean().optional().describe("Sync flags from Stripe (default true)"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ sync }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) {
        return missingKeyResult("use a dashboard API key or OAuth (not an agent key)");
      }
      const qs = sync === false ? "?sync=0" : sync === true ? "?sync=1" : "";
      const result = await callBeecargoApi({
        apiKey,
        method: "GET",
        path: `/connect/status${qs}`,
      });
      const extra =
        result.status === 403 || result.status === 401
          ? [
              `Agent keys cannot manage payouts. Send the human to ${CONNECT_DASHBOARD_FALLBACK} while signed in.`,
            ]
          : undefined;
      return {
        content: [{ type: "text", text: formatToolResult(result, extra) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_connect_onboard",
    {
      title: "Connect seller payouts",
      description:
        "Create a Stripe Express onboarding link for the seller. Send onboardUrl to the human. Requires a dashboard API key or OAuth — not an agent bootstrap key. After they finish, call beecargo_connect_status until readyToSell, then set priceCents via beecargo_update_share_settings.",
      inputSchema: z.object({
        country: z
          .string()
          .length(2)
          .optional()
          .describe("ISO country for new Express accounts (default US)"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ country }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: [
                "Missing dashboard API key or OAuth for seller payouts.",
                `Send the human to ${CONNECT_DASHBOARD_FALLBACK} while signed in.`,
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }
      const result = await callBeecargoApi({
        apiKey,
        method: "POST",
        path: "/connect/onboard",
        body: country ? { country } : {},
      });
      if (!result.ok && (result.status === 403 || result.status === 401)) {
        return {
          content: [
            {
              type: "text",
              text: formatToolResult(result, [
                `Cannot mint onboarding from this key. Send the human to ${CONNECT_DASHBOARD_FALLBACK} while signed in.`,
              ]),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_connect_login_link",
    {
      title: "Open Stripe Express dashboard",
      description:
        "Mint a short-lived Stripe Express login URL so the seller can see payouts and bank details. Requires Connect already started and a dashboard API key or OAuth.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) {
        return missingKeyResult("use a dashboard API key or OAuth (not an agent key)");
      }
      const result = await callBeecargoApi({
        apiKey,
        method: "POST",
        path: "/connect/login-link",
        body: {},
      });
      const extra =
        result.status === 403 || result.status === 401
          ? [
              `Agent keys cannot open Express. Send the human to ${CONNECT_DASHBOARD_FALLBACK} while signed in.`,
            ]
          : undefined;
      return {
        content: [{ type: "text", text: formatToolResult(result, extra) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_update_share_settings",
    {
      title: "Update share settings",
      description:
        "Change visibility, one-time price (priceCents), direct download, retention, or unlock protection on an owned file or growable Shipment. Pass fileId and/or shortId (bundle shareShortId from openShare). Setting a price requires seller Connect readyToSell (beecargo_connect_onboard first). Requires API key.",
      inputSchema: z.object({
        fileId: FILE_ID.optional(),
        shortId: z
          .string()
          .min(4)
          .max(16)
          .optional()
          .describe(
            "Shipment shortId (growable bundle from openShare, or one-file share code)",
          ),
        visibility: z.enum(["unlisted", "public"]).optional(),
        priceCents: z
          .number()
          .int()
          .min(0)
          .max(99_999_999)
          .nullable()
          .optional()
          .describe(
            "One-time price in the smallest currency unit (min 100). Pass 0 or null to clear. Requires Connect readyToSell for a positive price. Pair with currency (default usd).",
          ),
        currency: z
          .enum(["usd", "eur", "aed", "brl", "jpy", "krw", "cny", "rub"])
          .optional()
          .describe(
            "Charge currency for priceCents (usd/eur/aed/brl/jpy/krw/cny/rub). Defaults to usd. JPY/KRW are whole units.",
          ),
        direct: z.boolean().optional().describe("Pro: auto-download on /d link"),
        retention: z.enum(["ttl", "forever"]).optional(),
        expiresAt: z.string().optional().describe("ISO expiry when retention is ttl"),
        extendTtl: z
          .string()
          .optional()
          .describe(
            "Additive TTL preset like 24h or 7d (mutually exclusive with expiresAt/ttl)",
          ),
        protect: z
          .boolean()
          .optional()
          .describe(
            "When true, create a download unlock code and delivery link (returned once). When false, clear protection.",
          ),
        handoffMessage: z
          .string()
          .max(480)
          .optional()
          .describe(
            "Optional note shown on the delivery magic link (/h/…). Returned once with handoffUrl when protect is true.",
          ),
        immutable: z.boolean().optional(),
        upstreamFileIds: z.array(FILE_ID).max(20).optional(),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      annotations: { readOnlyHint: false },
    },
    async ({
      fileId,
      shortId,
      visibility,
      priceCents,
      currency,
      direct,
      retention,
      expiresAt,
      extendTtl,
      protect,
      handoffMessage,
      immutable,
      upstreamFileIds,
      idempotencyKey,
    }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      if (!fileId && !shortId) {
        return {
          content: [
            {
              type: "text",
              text: "Pass fileId and/or shortId (Shipment share code).",
            },
          ],
          isError: true,
        };
      }
      const result = await callBeecargoApi({
        apiKey,
        method: "PATCH",
        path: "/files/share-settings",
        body: {
          ...(fileId ? { fileId } : {}),
          ...(shortId ? { shortId } : {}),
          visibility,
          ...(priceCents !== undefined ? { priceCents } : {}),
          ...(currency !== undefined ? { currency } : {}),
          direct,
          retention,
          expiresAt,
          extendTtl,
          protect,
          handoffMessage,
          immutable,
          upstreamFileIds,
        },
        idempotencyKey,
      });
      const extra =
        !result.ok &&
        typeof result.body === "object" &&
        result.body &&
        JSON.stringify(result.body).includes("Connect Stripe")
          ? [
              "Seller is not ready to sell. Call beecargo_connect_onboard and send onboardUrl to the human, or send them to " +
                CONNECT_DASHBOARD_FALLBACK +
                ".",
            ]
          : undefined;
      return {
        content: [{ type: "text", text: formatToolResult(result, extra) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_create_folder",
    {
      title: "Create folder",
      description: "Create a folder under the authenticated API key.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        parentId: z.string().uuid().optional().nullable(),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ name, parentId }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      const result = await callBeecargoApi({
        apiKey,
        method: "POST",
        path: "/folders",
        body: { name, parentId: parentId ?? null },
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_list_folders",
    {
      title: "List folders",
      description: "List folders for the authenticated API key.",
      inputSchema: z.object({
        parentId: z.string().optional(),
        page: z.number().int().min(1).optional().default(1),
        limit: z.number().int().min(1).max(200).optional().default(50),
        search: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ parentId, page, limit, search }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (parentId) params.set("parentId", parentId);
      if (search) params.set("search", search);
      const result = await callBeecargoApi({
        apiKey,
        method: "GET",
        path: `/folders/list?${params.toString()}`,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_get_download_url",
    {
      title: "Get download URL",
      description:
        "Get a signed download URL for a file by fileId. If share meta or file_info reports unlockRequired, you must pass unlockCode, unlockToken, or handoffToken. Priced shares require purchaseToken (from the human /d/{shortId} pay + claim flow) or owner auth. If the body includes scanPending / SCAN_PENDING, wait retryAfterSeconds (~15) and retry, or poll share meta until scanStatus is clean.",
      inputSchema: z.object({
        fileId: FILE_ID,
        unlockCode: z
          .string()
          .optional()
          .describe("Required when the share has unlock protection enabled"),
        unlockToken: z
          .string()
          .optional()
          .describe("Short-lived token from POST /downloads/unlock"),
        handoffToken: z
          .string()
          .optional()
          .describe("Delivery link token from /h/… (alternative to unlockCode)"),
        purchaseToken: z
          .string()
          .optional()
          .describe(
            "Required for priced shares after the human pays on /d/{shortId} (from POST /purchases/claim)",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId, unlockCode, unlockToken, handoffToken, purchaseToken }) => {
      const params = new URLSearchParams();
      if (unlockToken) params.set("unlockToken", unlockToken);
      if (unlockCode) params.set("unlockCode", unlockCode);
      if (handoffToken) params.set("handoffToken", handoffToken);
      if (purchaseToken) params.set("purchaseToken", purchaseToken);
      const qs = params.toString();
      const result = await callBeecargoApi({
        apiKey: ctx.getApiKey(),
        method: "GET",
        path: `/files/download/${encodeURIComponent(fileId)}${qs ? `?${qs}` : ""}`,
      });
      const extra =
        result.status === 402
          ? [
              "Payment required. Call beecargo_purchase_checkout with shortId/fileId, send checkoutUrl to the human, then beecargo_purchase_claim with sessionId, then retry this tool with purchaseToken. Or send them to https://beecargo.net/d/{shortId}. Owners can download with their API key.",
            ]
          : undefined;
      return {
        content: [{ type: "text", text: formatToolResult(result, extra) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_file_info",
    {
      title: "File info by short codes",
      description:
        "Batch metadata lookup by comma-separated shortCodes. Check unlockRequired on each result before calling beecargo_get_download_url.",
      inputSchema: z.object({
        fileCodes: z
          .string()
          .min(1)
          .describe("Comma-separated short codes, e.g. abc12,xyz99"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileCodes }) => {
      const result = await callBeecargoApi({
        apiKey: ctx.getApiKey(),
        method: "GET",
        path: `/files/info?file_code=${encodeURIComponent(fileCodes)}`,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_list_files",
    {
      title: "List owned files",
      description:
        "List files for the authenticated API key. Set includeFolders true to also return sibling folders.",
      inputSchema: z.object({
        page: z.number().int().min(1).optional().default(1),
        limit: z.number().int().min(1).max(200).optional().default(50),
        folderId: z.string().optional(),
        includeFolders: z.boolean().optional().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page, limit, folderId, includeFolders }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) {
        return missingKeyResult("set BEECARGO_API_KEY or x-beecargo-api-key for list");
      }
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        includeFolders: includeFolders ? "true" : "false",
      });
      if (folderId) params.set("folderId", folderId);
      const result = await callBeecargoApi({
        apiKey,
        method: "GET",
        path: `/files/list?${params.toString()}`,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_run_artifacts",
    {
      title: "Run artifacts manifest",
      description: "List files uploaded with the same runId on your account.",
      inputSchema: z.object({
        runId: z.string().min(1).max(120),
        limit: z.number().int().min(1).max(500).optional().default(100),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ runId, limit }) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      const result = await callBeecargoApi({
        apiKey,
        method: "GET",
        path: `/files/run/${encodeURIComponent(runId)}?limit=${limit}`,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_delete_file",
    {
      title: "Delete file",
      description:
        "Delete by fileId. Use API key for owned files, or deletionToken for anonymous uploads.",
      inputSchema: z.object({
        fileId: FILE_ID,
        deletionToken: z.string().optional(),
        force: z
          .boolean()
          .optional()
          .describe("Required to delete immutable files or files with dependents"),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      annotations: { destructiveHint: true },
    },
    async ({ fileId, deletionToken, force, idempotencyKey }) => {
      const params = new URLSearchParams({ fileId });
      if (deletionToken) params.set("token", deletionToken);
      if (force) params.set("force", "true");
      const result = await callBeecargoApi({
        apiKey: ctx.getApiKey(),
        method: "DELETE",
        path: `/files/delete?${params.toString()}`,
        idempotencyKey,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  registerTool(
    "beecargo_create_upload_delegation",
    {
      title: "Create upload delegation (advanced)",
      description:
        "Advanced only: create a short-lived uploadUrl + delegationToken so a worker can PUT bytes without holding your full API key. Prefer beecargo_upload for normal agent uploads (url, path on stdio, or small contentBase64). No anonymous delegation.",
      inputSchema: z.object({
        name: z.string().min(1).max(240),
        sizeBytes: z.number().int().positive(),
        contentType: z.string().optional(),
        folderId: z.string().optional(),
        visibility: z.enum(["unlisted", "public"]).optional(),
        ttl: z.string().optional(),
        once: z.boolean().optional(),
        runId: z.string().max(120).optional(),
        immutable: z.boolean().optional(),
        upstreamFileIds: z.array(FILE_ID).max(20).optional(),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      annotations: { readOnlyHint: false },
    },
    async (input) => {
      const apiKey = ctx.getApiKey();
      if (!apiKey) return missingKeyResult();
      const { idempotencyKey, ...body } = input;
      const result = await callBeecargoApi({
        apiKey,
        method: "POST",
        path: "/files/upload-delegations",
        body,
        idempotencyKey,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

  return server;
}
