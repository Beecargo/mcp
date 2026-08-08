/**
 * Unit-style checks for env-config bearer parsing (no network).
 */
import { parseBearerCsvTokens, getMcpReadinessChecks } from "../src/env-config.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(parseBearerCsvTokens("a,b").length === 2, "CSV parse");
assert(parseBearerCsvTokens("  tok  ")[0] === "tok", "trim");

let threw = false;
try {
  parseBearerCsvTokens("dup,dup");
} catch {
  threw = true;
}
assert(threw, "duplicate segments rejected");

const prevRequire = process.env.BEECARGO_MCP_REQUIRE_AUTH;
const prevBearer = process.env.BEECARGO_MCP_BEARER_TOKEN;
process.env.BEECARGO_MCP_REQUIRE_AUTH = "true";
delete process.env.BEECARGO_MCP_BEARER_TOKEN;
const locked = getMcpReadinessChecks();
assert(
  locked.checks.some((c) => c.name === "mcp_require_auth_bearer" && !c.ok),
  "require auth without bearer fails readiness",
);
process.env.BEECARGO_MCP_REQUIRE_AUTH = prevRequire;
if (prevBearer !== undefined) {
  process.env.BEECARGO_MCP_BEARER_TOKEN = prevBearer;
} else {
  delete process.env.BEECARGO_MCP_BEARER_TOKEN;
}

console.log("smoke-env-config: ok");
