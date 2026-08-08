#!/usr/bin/env node
/**
 * Minimal Beecargo CLI — upload with a progress line on stderr.
 * Usage: beecargo upload <path> [--type mime] [--key bc_…]
 */
import { uploadLocalFile } from "./local-upload.js";

function usage(): never {
  console.error(`Usage:
  beecargo upload <path> [--type <mime>] [--key <bc_…>]

Env:
  BEECARGO_API_KEY   API key (optional for anonymous within 1GB)
  BEECARGO_API_URL   default https://api.beecargo.net
`);
  process.exit(1);
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "upload" || !argv[1] || argv.includes("-h") || argv.includes("--help")) {
    usage();
  }

  const filePath = argv[1]!;
  const contentType = argValue(argv, "--type") ?? "application/octet-stream";
  const apiKey =
    argValue(argv, "--key") ?? process.env.BEECARGO_API_KEY?.trim() ?? null;

  let lastLine = "";
  const result = await uploadLocalFile({
    apiKey,
    filePath,
    contentType,
    onProgress: (p) => {
      const pct =
        p.total > 0 ? Math.min(100, Math.round((p.progress / p.total) * 100)) : 0;
      const barWidth = 24;
      const filled = Math.round((pct / 100) * barWidth);
      const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
      const line = `  [${bar}] ${pct}%  ${p.message}`;
      if (line !== lastLine) {
        process.stderr.write(`\r${line.padEnd(80)}`);
        lastLine = line;
      }
    },
  });

  process.stderr.write("\n");
  console.log(result.text);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
