/**
 * Unit-style checks for env-config bearer parsing (no network).
 */
import { parseBearerCsvTokens, getMcpReadinessChecks } from "../src/env-config.js";
import { buildProtectedResourceMetadata } from "../src/oauth-metadata.js";

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

const prevOauth = process.env.BEECARGO_MERCHANT_OAUTH_ENABLED;
delete process.env.BEECARGO_MERCHANT_OAUTH_ENABLED;
const offMeta = buildProtectedResourceMetadata() as {
  authorization_servers?: string[];
};
assert(
  !("authorization_servers" in offMeta) || offMeta.authorization_servers === undefined,
  "disabled OAuth must not advertise an empty authorization_servers list",
);
process.env.BEECARGO_MERCHANT_OAUTH_ENABLED = "true";
const onMeta = buildProtectedResourceMetadata();
assert(
  Array.isArray(onMeta.authorization_servers) &&
    onMeta.authorization_servers.length === 1,
  "enabled OAuth advertises the API as authorization server",
);
if (prevOauth !== undefined) {
  process.env.BEECARGO_MERCHANT_OAUTH_ENABLED = prevOauth;
} else {
  delete process.env.BEECARGO_MERCHANT_OAUTH_ENABLED;
}

console.log("smoke-env-config: ok");
