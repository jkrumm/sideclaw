import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { logger } from "../logger.ts";
import { mcpHeartbeat } from "../session-runner.ts";
import { visionRead } from "../../lib/iu-openai.ts";
import { loadImageAsBase64 } from "../../lib/image.ts";

// Structural diagram-reading prompt (the bake-off default). Works for arbitrary
// images too; it just asks for a faithful, structured description.
export const DEFAULT_READ_PROMPT = `You are reading an image, often a diagram. Describe it faithfully and structurally:
- Overall layout, composition, and flow direction.
- Every distinct node/shape: its label (verbatim), type, and which group/frame/section it belongs to. Preserve nesting — do not flatten frames or sections.
- Every connection: source -> target, the edge label if any, and whether it is dashed/dotted (optional/async) or bidirectional.
- Color coding and any visual hierarchy that carries meaning.
- Any free-floating text (titles, annotations).
Be precise with labels and structure; if text is hard to read, say so rather than guessing.`;

const USAGE_SCHEMA = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  })
  .optional();

const READ_IMAGE_OUTPUT = z.object({
  text: z.string().describe("The model's structured reading of the image."),
  model: z.string().describe("Vision model used."),
  latencyMs: z.number().describe("End-to-end call latency in ms."),
  usage: USAGE_SCHEMA.describe("Token usage reported by the model, if present."),
});

export function registerReadImageTool(server: McpServer): void {
  server.registerTool(
    "read_image",
    {
      title: "Read Image (vision)",
      description: `Interpret an image (or SVG) with a vision model and return a structured text reading.

WHEN TO CALL: to understand a screenshot, diagram, photo, or any image as text. For paired Excalidraw drawings (.svg + .excalidraw) prefer read_drawing.
READ-ONLY: never modifies files (SVGs are rasterized to a temp PNG that is cleaned up). Safe to retry.
CWD: pass an absolute file path. SVGs are rasterized via headless Chrome first; other formats read as-is.
OUTPUT: \`text\` holds the reading. Default model gemini-3.5-flash (fast, strong on dense diagrams). Routes to a non-EU vendor — fine for git-committed/non-sensitive images.`,
      inputSchema: {
        path: z.string().describe("Absolute path to the image file (.png/.jpg/.svg/...)."),
        prompt: z
          .string()
          .optional()
          .describe(
            "Custom instruction for the read. Defaults to a structural diagram-reading prompt.",
          ),
        model: z
          .string()
          .optional()
          .describe('Vision model. Default "gemini-3.5-flash". Not a residency knob.'),
      },
      outputSchema: READ_IMAGE_OUTPUT.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ path, prompt, model }, extra) => {
      const startMs = performance.now();
      if (!existsSync(path)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `File not found: ${path}` }) }],
          isError: true,
        };
      }
      logger.info(
        { event: "mcp.tool.start", tool: "read_image", path, model },
        "read_image starting",
      );
      const stop = mcpHeartbeat(extra, "read_image");
      try {
        const { base64, mimeType } = await loadImageAsBase64(path);
        const visionResult = await visionRead({
          imageBase64: base64,
          mimeType,
          prompt: prompt ?? DEFAULT_READ_PROMPT,
          model,
          tool: "read_image",
        });
        const result = { ...visionResult, latencyMs: Math.round(performance.now() - startMs) };
        logger.info(
          {
            event: "mcp.tool.end",
            tool: "read_image",
            model: result.model,
            bytes: base64.length,
            durationMs: result.latencyMs,
            tokens: result.usage?.totalTokens,
          },
          "read_image done",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "read_image",
            error: String(err),
            durationMs: Math.round(performance.now() - startMs),
          },
          "read_image failed",
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      } finally {
        stop();
      }
    },
  );
}
