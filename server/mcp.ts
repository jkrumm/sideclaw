import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckTool } from "./mcp/tools/check.ts";
import { registerResearchTool } from "./mcp/tools/research.ts";
import { registerReviewTool } from "./mcp/tools/review.ts";
import { registerImplementTool } from "./mcp/tools/implement.ts";
import { registerOtelTool } from "./mcp/tools/otel.ts";
import { registerJobTools } from "./mcp/tools/jobs.ts";
import { logger } from "./mcp/logger.ts";

const server = new McpServer({
  name: "sideclaw",
  version: "0.1.0",
});

registerCheckTool(server);
registerOtelTool(server);
registerResearchTool(server);
registerReviewTool(server);
registerImplementTool(server);
registerJobTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info({ event: "mcp.startup" }, "sideclaw mcp server ready");
