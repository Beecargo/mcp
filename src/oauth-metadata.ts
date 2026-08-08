import {
  getApiBaseUrl,
  getMcpPublicOrigin,
  merchantOAuthEnabled,
} from "./env-config.js";

export function buildProtectedResourceMetadata() {
  const resource = `${getMcpPublicOrigin()}/mcp`;
  const apiBase = getApiBaseUrl();
  return {
    resource,
    authorization_servers: merchantOAuthEnabled() ? [apiBase.replace(/\/$/, "")] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["files.read", "files.write"],
    resource_documentation: "https://beecargo.net/docs/mcp/overview",
  };
}
