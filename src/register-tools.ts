import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callBeecargoApi } from "./api-client.js";
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
    summary: "Self-register bootstrap bc_* machine key (tight limits)",
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
    summary: "Set visibility, direct, retention, expiry on owned file",
  },
  { name: "beecargo_delete_file", summary: "Delete by fileId + optional token" },
  {
    name: "beecargo_run_artifacts",
    summary: "List files uploaded under a runId (pipeline manifest)",
  },
  {
    name: "beecargo_create_upload_delegation",
    summary: "Mint short-lived direct-to-R2 upload delegation for agents",
  },
  {
    name: "beecargo_create_checkout",
    summary: "Mint Premium Stripe checkout (trial if eligible, else weekly)",
  },
  { name: "beecargo_search_tools", summary: "Search available MCP tools" },
] as const;

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
  "beecargo_search_tools",
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
      const catalog =
        toolSet === "guest"
          ? TOOL_CATALOG.filter((t) => GUEST_MCP_TOOL_NAMES.has(t.name))
          : TOOL_CATALOG;
      const matches = catalog
        .filter((t) => !q || t.name.includes(q) || t.summary.toLowerCase().includes(q))
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
        "Create a bootstrap bc_* machine key (files_write, free-tier quotas). No API key required. Rate-limited per IP. For production agents with 500GB included concurrent storage/1000rpm, mint via Pro dashboard POST /api-keys/agent. After success, this MCP session adopts the key.",
      inputSchema: z.object({
        label: z.string().max(120).optional().describe("Optional key label"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ label }) => {
      const result = await callBeecargoApi({
        apiKey: null,
        method: "POST",
        path: "/agent/register",
        body: { label: label ?? "mcp-agent" },
      });
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
        "Mint a Stripe Checkout URL for a human to subscribe to Premium. Default plan=recommended: trial if the signed-in human still has the intro offer, otherwise weekly. Agent/guest sessions always get weekly (trial needs a real signed-in account). Prefer recommended; use weekly/monthly/annual only if the human asks. No API key required for guest mint — do not send session bc_* for guest checkout. Send the returned url to the human. After pay + claim at /checkout/complete, mint Pro bc_* via dashboard POST /api-keys/agent.",
      inputSchema: z.object({
        plan: z
          .enum(["recommended", "weekly", "monthly", "annual"])
          .default("recommended")
          .describe(
            "recommended = trial if eligible else weekly (default). weekly/monthly/annual only if the human asks.",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ plan }) => {
      // Guest mint must omit Bearer — agent bc_* machine emails cannot use logged-in checkout.
      // recommended + no key → weekly (same product rule as dashboard when trial is unavailable).
      const result = await callBeecargoApi({
        apiKey: null,
        method: "POST",
        path: "/billing/checkout",
        body: { plan },
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
        isError: !result.ok,
      };
    },
  );

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
        "One upload tool: public url (sync or background job), contentBase64 (small), or path on stdio (auto multipart). Anonymous, free, and Pro limits match the API. Returns share link and fileId.",
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
    "beecargo_update_share_settings",
    {
      title: "Update share settings",
      description:
        "Change visibility, direct download, and retention on an owned file. Requires API key. Pro defaults to keeping files while subscribed; set expiresAt to any future ISO date within 90 days for automatic deletion.",
      inputSchema: z.object({
        fileId: FILE_ID,
        visibility: z.enum(["unlisted", "public"]).optional(),
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
            "When true, mint a download unlock code and delivery link (returned once). When false, clear protection.",
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
      visibility,
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
      const result = await callBeecargoApi({
        apiKey,
        method: "PATCH",
        path: "/files/share-settings",
        body: {
          fileId,
          visibility,
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
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
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
        "Get a signed download URL for a file by fileId. If share meta or file_info reports unlockRequired, you must pass unlockCode, unlockToken, or handoffToken.",
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
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fileId, unlockCode, unlockToken, handoffToken }) => {
      const params = new URLSearchParams();
      if (unlockToken) params.set("unlockToken", unlockToken);
      if (unlockCode) params.set("unlockCode", unlockCode);
      if (handoffToken) params.set("handoffToken", handoffToken);
      const qs = params.toString();
      const result = await callBeecargoApi({
        apiKey: null,
        method: "GET",
        path: `/files/download/${encodeURIComponent(fileId)}${qs ? `?${qs}` : ""}`,
      });
      return {
        content: [{ type: "text", text: formatToolResult(result) }],
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
      title: "Create upload delegation",
      description:
        "Mint a short-lived direct-to-R2 upload for an owned/bootstrap/Pro API key. PUT bytes to uploadUrl, then POST completeUrl with delegationToken. No anonymous delegation.",
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
