import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EXCALIDRAW_DIAGRAM_INPUT } from "../../jobs/handlers/excalidraw-diagram.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerExcalidrawDiagramTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "excalidraw_diagram",
    title: "Create Excalidraw Diagram",
    tool: "excalidraw_diagram",
    inputSchema: EXCALIDRAW_DIAGRAM_INPUT.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description: `Generate a fully-hydrated \`.excalidraw\` v2 file from a design brief. The worker emits skeleton JSON; the host hydrates via @excalidraw/excalidraw in headless Chrome and writes the file. The result opens cleanly in sideclaw's DiagramPanel, the Obsidian Excalidraw plugin (zsviczian), and excalidraw.com. Runs as a BACKGROUND JOB: returns a jobId immediately — it does NOT return the result.

WHEN TO CALL: when the user wants a diagram of a workflow, architecture, system, protocol, or concept. The skill prompt owns the cheat sheet (palette, fonts, patterns) — pass a design brief, not raw JSON.
ASYNC: returns { jobId }. Call job_wait({ jobId }) to block until it finishes and read \`{ outputPath, elementCount, viewport, hydratedBytes, rationale }\`.
SIDE EFFECTS: writes the .excalidraw file at \`outputPath\` (overwrites in \`create\` mode; rewrites in \`extend\` mode after reading the existing file as context).
PATHS: \`outputPath\` must be absolute and end in \`.excalidraw\`. Parent directories are created automatically.`,
  });
}
