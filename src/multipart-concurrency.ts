const GIB = 1024 * 1024 * 1024;

/** Concurrent multipart part uploads (mirrors @beecargo/shared bands). */
export function multipartUploadConcurrency(fileSizeBytes: number): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return 4;
  if (fileSizeBytes > 50 * GIB) return 3;
  if (fileSizeBytes > 10 * GIB) return 4;
  if (fileSizeBytes > 1 * GIB) return 5;
  return 6;
}

/** Run async work over items with a fixed worker pool. Preserves result order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
