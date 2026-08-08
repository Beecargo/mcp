import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOptionalApiKey } from "./env-config.js";
import { createBeecargoMcpServer } from "./register-tools.js";

export async function startStdioServer(): Promise<void> {
  let apiKey = getOptionalApiKey();
  const server = createBeecargoMcpServer(
    {
      getApiKey: () => apiKey,
      setApiKey: (key) => {
        apiKey = key;
      },
    },
    "stdio",
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
