import { z } from "zod";
import { callBeecargoApi } from "./api-client.js";
import { formatToolResult } from "./api-response.js";
import { uploadLocalFile } from "./local-upload.js";
import type { InstructionMode } from "./instruction-mode.js";
import { mcpMaxBodyBytes } from "./env-config.js";

const DIRECT_UPLOAD_LIMIT = 4 * 1024 * 1024;

function publishFieldsFromInput(input: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  const keys = [
    "visibility",
    "direct",
    "retention",
    "expiresAt",
    "ttl",
    "grace",
    "maxDownloads",
    "once",
    "protect",
    "handoffMessage",
    "runId",
    "step",
    "intent",
    "consumer",
    "openShare",
    "shareShortId",
  ] as const;
  for (const key of keys) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  return fields;
}

function appendPublishFields(form: FormData, input: Record<string, unknown>) {
  const fields = publishFieldsFromInput(input);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : String(value));
  }
}

export async function pollRemoteJob(options: {
  apiKey: string | null;
  jobId: string;
  jobSecret?: string;
  waitSeconds?: number;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const deadline = Date.now() + (options.waitSeconds ?? 0) * 1000;
  const secretQ = options.jobSecret
    ? `?secret=${encodeURIComponent(options.jobSecret)}`
    : "";
  let lastText = "";
  for (;;) {
    const result = await callBeecargoApi({
      apiKey: options.apiKey,
      method: "GET",
      path: `/files/remote-multipart/${encodeURIComponent(options.jobId)}${secretQ}`,
    });
    lastText = formatToolResult(result);
    const data =
      result.body && typeof result.body === "object"
        ? ((result.body as { data?: { status?: string; phase?: string } }).data ?? null)
        : null;
    const status = data?.status ?? "unknown";
    await options.onProgress?.(data?.phase ?? `Remote job ${status}`);
    if (
      !options.waitSeconds ||
      status === "completed" ||
      status === "failed" ||
      Date.now() >= deadline
    ) {
      return {
        ok: result.ok && status !== "failed",
        status: result.status,
        body: result.body,
        text: lastText,
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function runBeecargoUpload(args: {
  mode: InstructionMode;
  apiKey: string | null;
  input: {
    url?: string;
    path?: string;
    contentBase64?: string;
    fileName?: string;
    contentType?: string;
    folderId?: string;
    background?: boolean;
    waitSeconds?: number;
    visibility?: "unlisted" | "public";
    direct?: boolean;
    retention?: "ttl" | "forever";
    expiresAt?: string;
    ttl?: string;
    grace?: string | number;
    maxDownloads?: number;
    once?: boolean;
    protect?: boolean;
    handoffMessage?: string;
    runId?: string;
    step?: string;
    intent?: string;
    consumer?: string;
    openShare?: boolean;
    shareShortId?: string;
  };
  onProgress?: (p: {
    progress: number;
    total: number;
    message: string;
  }) => void | Promise<void>;
}): Promise<{ ok: boolean; text: string; isError: boolean }> {
  const {
    url,
    path: filePath,
    contentBase64,
    fileName,
    contentType,
    folderId,
    background,
    waitSeconds,
    visibility,
    direct,
    retention,
    expiresAt,
    ttl,
    grace,
    maxDownloads,
    once,
    protect,
    handoffMessage,
    runId,
    step,
    intent,
    consumer,
  } = args.input;

  const publishBody = publishFieldsFromInput(args.input);

  const sources = [url, filePath, contentBase64].filter(Boolean).length;
  if (sources !== 1) {
    return {
      ok: false,
      isError: true,
      text: "Provide exactly one of: url, path (stdio only), or contentBase64.",
    };
  }

  if (filePath) {
    if (args.mode === "http") {
      return {
        ok: false,
        isError: true,
        text: "path uploads are not available on hosted HTTP MCP. Use url, contentBase64, or stdio/CLI.",
      };
    }
    try {
      const result = await uploadLocalFile({
        apiKey: args.apiKey,
        filePath,
        contentType: contentType ?? "application/octet-stream",
        folderId,
        publish: publishBody,
        onProgress: args.onProgress,
      });
      return { ok: result.ok, text: result.text, isError: !result.ok };
    } catch (err) {
      return {
        ok: false,
        isError: true,
        text: err instanceof Error ? err.message : "Upload failed",
      };
    }
  }

  if (contentBase64) {
    if (!fileName?.trim()) {
      return {
        ok: false,
        isError: true,
        text: "fileName is required with contentBase64.",
      };
    }
    const buffer = Buffer.from(contentBase64, "base64");
    const maxInline = Math.min(DIRECT_UPLOAD_LIMIT, mcpMaxBodyBytes());
    if (buffer.length > maxInline) {
      return {
        ok: false,
        isError: true,
        text: `Inline file exceeds ${maxInline} bytes. Use url (public HTTPS), path on stdio, or API multipart.`,
      };
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([buffer], { type: contentType ?? "application/octet-stream" }),
      fileName,
    );
    if (folderId) form.append("folderId", folderId);
    appendPublishFields(form, args.input);
    const result = await callBeecargoApi({
      apiKey: args.apiKey,
      method: "POST",
      path: "/files/upload",
      formData: form,
    });
    return {
      ok: result.ok,
      text: formatToolResult(result),
      isError: !result.ok,
    };
  }

  if (!url) {
    return { ok: false, isError: true, text: "url is required." };
  }

  if (background || (waitSeconds ?? 0) > 0) {
    const init = await callBeecargoApi({
      apiKey: args.apiKey,
      method: "POST",
      path: "/files/remote-multipart/init",
      body: { url, folderId: folderId ?? null },
    });
    if (!init.ok) {
      return { ok: false, text: formatToolResult(init), isError: true };
    }
    const initData =
      init.body && typeof init.body === "object"
        ? ((init.body as { data?: { jobId?: string; jobSecret?: string } }).data ??
          null)
        : null;
    const jobId = initData?.jobId;
    const jobSecret = initData?.jobSecret;
    if (!jobId) {
      return { ok: false, text: formatToolResult(init), isError: true };
    }
    if (!waitSeconds) {
      return {
        ok: true,
        text: `${formatToolResult(init)}\n\nPoll with beecargo_upload_status (jobId, jobSecret).`,
        isError: false,
      };
    }
    const polled = await pollRemoteJob({
      apiKey: args.apiKey,
      jobId,
      jobSecret,
      waitSeconds,
      onProgress: async (message) => {
        await args.onProgress?.({ progress: 0, total: 1, message });
      },
    });
    return { ok: polled.ok, text: polled.text, isError: !polled.ok };
  }

  const result = await callBeecargoApi({
    apiKey: args.apiKey,
    method: "POST",
    path: "/files/remote-upload",
    body: { url, folderId: folderId ?? null, ...publishBody },
  });
  return {
    ok: result.ok,
    text: formatToolResult(result),
    isError: !result.ok,
  };
}

export function uploadInputSchema(mode: InstructionMode) {
  const base = z.object({
    url: z
      .string()
      .url()
      .optional()
      .describe("Public HTTPS URL (Beecargo fetches server-side)"),
    contentBase64: z
      .string()
      .min(1)
      .optional()
      .describe("Small file inline (under 4MB)"),
    fileName: z.string().min(1).optional().describe("Required with contentBase64"),
    contentType: z.string().optional().default("application/octet-stream"),
    folderId: z.string().optional().describe("Owned folder (authenticated)"),
    background: z
      .boolean()
      .optional()
      .describe(
        "Use async remote job (large/slow URLs); poll with beecargo_upload_status",
      ),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe(
        "When background is true, optionally wait up to N seconds for completion",
      ),
    visibility: z.enum(["unlisted", "public"]).optional(),
    direct: z.boolean().optional(),
    retention: z.enum(["ttl", "forever"]).optional(),
    expiresAt: z.string().optional(),
    ttl: z.string().optional().describe("Expiry preset: 1h, 24h, 7d"),
    grace: z.union([z.string(), z.number()]).optional(),
    maxDownloads: z.number().int().positive().optional(),
    once: z.boolean().optional(),
    protect: z.boolean().optional(),
    handoffMessage: z.string().optional(),
    runId: z.string().optional(),
    step: z.string().optional(),
    intent: z.string().optional(),
    consumer: z.string().optional(),
    openShare: z
      .boolean()
      .optional()
      .describe(
        "Open a growable multi-file Shipment for this upload (returns shareShortId). Use shareShortId on later uploads to add files to the same /d link.",
      ),
    shareShortId: z
      .string()
      .min(4)
      .max(16)
      .optional()
      .describe(
        "Attach this upload to an existing growable Shipment from a prior openShare upload. Same share URL; does not mint a new shortId.",
      ),
  });
  if (mode === "stdio") {
    return base.extend({
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Local file path (stdio MCP only; auto direct/multipart)"),
    });
  }
  return base;
}
