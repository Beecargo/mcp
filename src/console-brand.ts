const BANNERS = [
  [
    " __                                         ",
    "/ /_  ___  ___  _________ __________ _____  ",
    "/ __ \\/ _ \\/ _ \\/ ___/ __ `/ ___/ __ `/ __ \\ ",
    "/ /_/ /  __/  __/ /__/ /_/ / /  / /_/ / /_/ / ",
    "/_.___/\\___/\\___/\\___/\\__,_/_/   \\__, /\\____/  ",
    "                               /____/       ",
  ],
  [
    "    __                                        ",
    "   / /_  ___  ___  _________ __________ ____  ",
    "  / __ \\/ _ \\/ _ \\/ ___/ __ `/ ___/ __ `/ __ \\ ",
    " / /_/ /  __/  __/ /__/ /_/ / /  / /_/ / /_/ / ",
    "/_.___/\\___/\\___/\\___/\\__,_/_/   \\__, /\\____/  ",
    "    _____ __                    /____/        ",
    "   / __(_) /__  _____                         ",
    "  / /_/ / / _ \\/ ___/                         ",
    " / __/ / /  __(__  )                          ",
    "/_/ /_/_/\\___/____/                           ",
  ],
  [
    " _                                              ",
    "| |__   ___  ___  ___ __ _ _ __ __ _  ___       ",
    "| '_ \\ / _ \\/ _ \\/ __/ _` | '__/ _` |/ _ \\      ",
    "| |_) |  __/  __/ (_| (_| | | | (_| | (_) |     ",
    "|_.__/ \\___|\\___|\\___\\__,_|_|  \\__, |\\___/      ",
    "                               |___/            ",
  ],
] as const;

const TAGLINES = [
  "mcp for humans and agents.",
  "connect your agent. ship the file.",
  "tools in. share link out.",
  "register. upload. done.",
  "the beecargo express speaks mcp.",
  "drop a url. get a link.",
] as const;

const LINKS = [
  { label: "Docs", url: "https://beecargo.net/docs/mcp/overview" },
  { label: "endpoint", url: "https://mcp.beecargo.net/mcp" },
  { label: "guest", url: "https://mcp.beecargo.net/mcp/guest" },
  { label: "connect", url: "https://beecargo.net/connect/mcp" },
  { label: "llms.txt", url: "https://beecargo.net/llms.txt" },
  { label: "api", url: "https://api.beecargo.net" },
] as const;

let bannerIndex = -1;
let taglineIndex = -1;

function getNextBanner(): string {
  bannerIndex = (bannerIndex + 1) % BANNERS.length;
  const banner = BANNERS[bannerIndex] ?? BANNERS[0];
  return banner.join("\n");
}

function getTagline(): string {
  taglineIndex = (taglineIndex + 1) % TAGLINES.length;
  return TAGLINES[taglineIndex] ?? TAGLINES[0];
}

/** Plain-text beecargo banner for human GETs to the MCP host (api-root style). */
export function getMcpBrandText(): string {
  const banner = getNextBanner();
  const tagline = getTagline();
  const links = LINKS.map(({ label, url }) => `- ${label}  ${url}`).join("\n");
  const auth =
    "Auth: Authorization Bearer bc_oat_… / bc_* / transport bearer.\nGuest tools: /mcp/guest";
  return `▲\n\n${banner}\n\n${tagline}\n\n${auth}\n\n${links}\n`;
}

/** Prints the beecargo MCP banner when the HTTP process starts. */
export function printMcpConsoleBrand(): void {
  console.log(`\n${getMcpBrandText()}`);
}
