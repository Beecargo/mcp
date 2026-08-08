import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { callBeecargoApi } from "./api-client.js";
import { formatToolResult } from "./api-response.js";

export type LocalUploadProgress = {
  progress: number;
  total: number;
  message: string;
};

type MultipartInitData = {
  uploadId: string;
  key: string;
  chunkSize: number;
  totalParts: number;
  uploadSessionToken?: string;
};

function unwrapData<T>(body: unknown): T | null {
  if (!body || typeof body !== "object") return null;
  const root = body as { data?: unknown; success?: boolean };
  if (root.data && typeof root.data === "object") return root.data as T;
  return body as T;
}

async function putPart(
  url: string,
  filePath: string,
  start: number,
  end: number,
): Promise<string> {
  const length = end - start;
  const stream = createReadStream(filePath, { start, end: end - 1 });
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Length": String(length),
      "Content-Type": "application/octet-stream",
    },
    // Node fetch accepts Node streams as body.
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Part upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const etag = res.headers.get("etag") ?? res.headers.get("ETag");
  if (!etag) throw new Error("Part upload missing ETag");
  return etag.replaceAll('"', "");
}

function appendPublishFields(form: FormData, publish?: Record<string, unknown>): void {
  if (!publish) return;
  for (const [key, value] of Object.entries(publish)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "string" ? value : String(value));
  }
}

/** Upload a local file via direct (<4MB) or multipart API; reports part progress. */
export async function uploadLocalFile(options: {
  apiKey: string | null;
  filePath: string;
  contentType?: string;
  folderId?: string;
  publish?: Record<string, unknown>;
  onProgress?: (p: LocalUploadProgress) => void | Promise<void>;
}): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const resolved = path.resolve(options.filePath);
  const info = await stat(resolved);
  if (!info.isFile()) {
    return {
      ok: false,
      status: 0,
      body: { error: "Not a file" },
      text: `Not a file: ${resolved}`,
    };
  }

  const fileName = path.basename(resolved);
  const contentType = options.contentType ?? "application/octet-stream";
  const fileSize = info.size;

  if (fileSize <= 4 * 1024 * 1024) {
    await options.onProgress?.({
      progress: 0,
      total: 1,
      message: "Uploading small file",
    });
    const handle = await open(resolved, "r");
    try {
      const buf = Buffer.alloc(fileSize);
      await handle.read(buf, 0, fileSize, 0);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(buf)], { type: contentType }),
        fileName,
      );
      if (options.folderId) form.append("folderId", options.folderId);
      appendPublishFields(form, options.publish);
      const result = await callBeecargoApi({
        apiKey: options.apiKey,
        method: "POST",
        path: "/files/upload",
        formData: form,
      });
      await options.onProgress?.({
        progress: 1,
        total: 1,
        message: "Upload complete",
      });
      return {
        ...result,
        text: formatToolResult(result),
      };
    } finally {
      await handle.close();
    }
  }

  const init = await callBeecargoApi({
    apiKey: options.apiKey,
    method: "POST",
    path: "/files/multipart/init",
    body: {
      fileName,
      fileSize,
      fileType: contentType,
      ...(options.folderId ? { folderId: options.folderId } : {}),
    },
  });
  if (!init.ok) {
    return { ...init, text: formatToolResult(init) };
  }

  const session = unwrapData<MultipartInitData>(init.body);
  if (!session?.uploadId || !session.key) {
    return {
      ok: false,
      status: init.status,
      body: init.body,
      text: "multipart/init missing uploadId/key",
    };
  }

  const urlsRes = await callBeecargoApi({
    apiKey: options.apiKey,
    method: "POST",
    path: "/files/multipart/batch-urls",
    body: {
      key: session.key,
      uploadId: session.uploadId,
      totalParts: session.totalParts,
      ...(session.uploadSessionToken
        ? { uploadSessionToken: session.uploadSessionToken }
        : {}),
    },
  });
  if (!urlsRes.ok) {
    return { ...urlsRes, text: formatToolResult(urlsRes) };
  }

  const urlPayload = unwrapData<{ urls?: Record<string, string> }>(urlsRes.body);
  const urls = urlPayload?.urls ?? {};
  const parts: { partNumber: number; etag: string }[] = [];

  for (let partNumber = 1; partNumber <= session.totalParts; partNumber++) {
    const url = urls[String(partNumber)];
    if (!url) {
      return {
        ok: false,
        status: 0,
        body: { error: `Missing URL for part ${partNumber}` },
        text: `Missing URL for part ${partNumber}`,
      };
    }
    const start = (partNumber - 1) * session.chunkSize;
    const end = Math.min(start + session.chunkSize, fileSize);
    await options.onProgress?.({
      progress: partNumber - 1,
      total: session.totalParts,
      message: `Uploading part ${partNumber}/${session.totalParts}`,
    });
    const etag = await putPart(url, resolved, start, end);
    parts.push({ partNumber, etag });
  }

  await options.onProgress?.({
    progress: session.totalParts,
    total: session.totalParts,
    message: "Completing multipart upload",
  });

  const complete = await callBeecargoApi({
    apiKey: options.apiKey,
    method: "POST",
    path: "/files/multipart/complete",
    body: {
      key: session.key,
      uploadId: session.uploadId,
      parts,
      fileName,
      fileSize,
      contentType,
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(session.uploadSessionToken
        ? { uploadSessionToken: session.uploadSessionToken }
        : {}),
      ...(options.publish ?? {}),
    },
  });

  return { ...complete, text: formatToolResult(complete) };
}
