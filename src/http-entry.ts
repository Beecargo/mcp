#!/usr/bin/env node
import { ensureProductionBearer } from "./env-config.js";
import { startHttpServer } from "./http.js";

ensureProductionBearer();

await startHttpServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
