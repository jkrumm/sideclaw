import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckTool } from "./mcp/tools/check.ts";

const server = new McpServer({
  name: "sideclaw",
  version: "0.1.0",
});

registerCheckTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[sideclaw mcp] server ready");
