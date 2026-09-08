// FIRST: the MCP process is spawned with the calling session's cwd, so Bun never auto-loaded
// sideclaw/.env here — otel and the routing/backend flags ran unconfigured. Order matters.
import "./lib/load-env.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckTool } from "./mcp/tools/check.ts";
import { registerReviewTool } from "./mcp/tools/review.ts";
import { registerOtelTool } from "./mcp/tools/otel.ts";
import { registerJobTools } from "./mcp/tools/jobs.ts";
import { registerReadImageTool } from "./mcp/tools/read-image.ts";
import { registerReadDrawingTool } from "./mcp/tools/read-drawing.ts";
import { registerExcalidrawDiagramTool } from "./mcp/tools/excalidraw-diagram.ts";
import { registerDispatchTool } from "./mcp/tools/dispatch.ts";
import { registerOverviewTool } from "./mcp/tools/overview.ts";
import { registerNarrativeTool } from "./mcp/tools/narrative.ts";
import { logger } from "./mcp/logger.ts";
import { setProcessKind } from "./lib/process-context.ts";

// "mcp" is already process-context.ts's default (preserved for callers that predate it), but
// set it explicitly here anyway — this is the one process that default exists to describe, and
// an explicit call survives a future change to that default.
setProcessKind("mcp");

const server = new McpServer({
  name: "sideclaw",
  version: "0.1.0",
});

registerCheckTool(server);
registerOtelTool(server);
registerReviewTool(server);
registerJobTools(server);
registerReadImageTool(server);
registerReadDrawingTool(server);
registerExcalidrawDiagramTool(server);
registerDispatchTool(server);
registerOverviewTool(server);
registerNarrativeTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info({ event: "mcp.startup" }, "sideclaw mcp server ready");
