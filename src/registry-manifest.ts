export const MCP_REGISTRY_NAME = "io.github.Beecargo/mcp";
export const MCP_REGISTRY_DESCRIPTION =
  "Publish a file from an agent and get a durable beecargo.net/d/{shortId} share link.";
export const MCP_PACKAGE_VERSION = "0.1.0";
export const MCP_SITE_ORIGIN = "https://beecargo.net";
export const MCP_HOSTED_URL = "https://mcp.beecargo.net/mcp";
export const MCP_GUEST_URL = "https://mcp.beecargo.net/mcp/guest";
export const MCP_GITHUB_REPO_URL = "https://github.com/Beecargo/mcp";
export const MCP_GITHUB_REPO_ID = "1328145311";

/** Official MCP Registry server.json (schema 2025-12-11). */
export function buildOfficialMcpServerJson() {
  return {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: MCP_REGISTRY_NAME,
    title: "Beecargo",
    description: MCP_REGISTRY_DESCRIPTION,
    version: MCP_PACKAGE_VERSION,
    websiteUrl: MCP_SITE_ORIGIN,
    repository: {
      url: MCP_GITHUB_REPO_URL,
      source: "github",
      id: MCP_GITHUB_REPO_ID,
    },
    icons: [
      {
        src: `${MCP_SITE_ORIGIN}/logo.png`,
        mimeType: "image/png" as const,
        sizes: ["1112x1112"],
      },
    ],
    remotes: [
      {
        type: "streamable-http" as const,
        url: MCP_HOSTED_URL,
      },
    ],
  };
}

export function buildMcpServerCard() {
  return {
    name: "beecargo",
    title: "Beecargo",
    version: MCP_PACKAGE_VERSION,
    description: MCP_REGISTRY_DESCRIPTION,
    websiteUrl: MCP_SITE_ORIGIN,
    icons: [
      {
        src: `${MCP_SITE_ORIGIN}/logo.png`,
        mimeType: "image/png" as const,
        sizes: ["1112x1112"],
      },
    ],
    transport: {
      type: "streamable-http",
      url: MCP_HOSTED_URL,
    },
    endpoints: {
      mcp: MCP_HOSTED_URL,
      guest: MCP_GUEST_URL,
      health: "https://mcp.beecargo.net/health",
    },
    documentation: `${MCP_SITE_ORIGIN}/docs/mcp/overview`,
    authentication: {
      optional: true,
      guest: MCP_GUEST_URL,
      schemes: ["none", "oauth", "bearer"],
      note: "Guest MCP needs no headers. Full MCP accepts OAuth or Authorization: Bearer bc_…",
    },
  };
}

export function buildMcpRobotsTxt(): string {
  return [
    "# Beecargo MCP host. Product site: https://beecargo.net",
    "User-agent: *",
    "Allow: /",
    "Allow: /.well-known/",
    "",
    "User-agent: ora-agent",
    "Allow: /",
    "",
    "Sitemap: https://beecargo.net/sitemap.xml",
    "",
  ].join("\n");
}

export function buildMcpLlmsTxt(): string {
  return [
    "# Beecargo MCP",
    "",
    "> Hosted Model Context Protocol for Beecargo artifact handoff.",
    "",
    "Publish a file from an agent and get a durable https://beecargo.net/d/{shortId} share link.",
    "",
    `- MCP: ${MCP_HOSTED_URL}`,
    `- Guest: ${MCP_GUEST_URL}`,
    "- Docs: https://beecargo.net/docs/mcp/overview",
    "- Product: https://beecargo.net",
    "- server.json: https://mcp.beecargo.net/.well-known/mcp/server.json",
    "",
  ].join("\n");
}
