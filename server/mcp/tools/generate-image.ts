import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger.ts";
import { mcpHeartbeat } from "../session-runner.ts";
import { generateImage } from "../../lib/iu-openai.ts";

const GENERATE_IMAGE_OUTPUT = z.object({
  path: z.string().describe("Absolute path to the written PNG file."),
  model: z.string().describe("Model that produced the image."),
  latencyMs: z.number().describe("End-to-end call latency in ms."),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional()
    .describe("Token usage reported by the model, if present."),
});

export function registerGenerateImageTool(server: McpServer): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: `Generate an image from a text prompt and write it to disk as PNG.

WHEN TO CALL: when you need to synthesize a diagram, illustration, or asset from a description.
SIDE EFFECTS: writes a PNG file. Routes to gpt-image-2 (OpenAI vendor, US) — fine for generated assets, NOT for content containing PII.
OUTPUT: \`path\` is the written PNG. Read it back with the Read tool to view it.
NOTE: dall-e-3 is dead (410); only gpt-image-{1,1-mini,1.5,2} work.`,
      inputSchema: {
        prompt: z.string().min(1).describe("Text description of the image to generate."),
        model: z
          .string()
          .optional()
          .describe('Image model. Default "gpt-image-2". Must be a gpt-image-* model.'),
        size: z
          .string()
          .optional()
          .describe('Image size, e.g. "1024x1024" (default), "1024x1536", "1536x1024".'),
        outputPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to write the PNG. Defaults to a temp file under the OS temp dir.",
          ),
      },
      outputSchema: GENERATE_IMAGE_OUTPUT.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    },
    async ({ prompt, model, size, outputPath }, extra) => {
      const startMs = performance.now();
      logger.info(
        { event: "mcp.tool.start", tool: "generate_image", model },
        "generate_image starting",
      );
      const stop = mcpHeartbeat(extra, "generate_image");
      try {
        const result = await generateImage({ prompt, model, size, outputPath });
        logger.info(
          {
            event: "mcp.tool.end",
            tool: "generate_image",
            model: result.model,
            durationMs: Math.round(performance.now() - startMs),
            tokens: result.usage?.totalTokens,
          },
          "generate_image done",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (err) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "generate_image",
            error: String(err),
            durationMs: Math.round(performance.now() - startMs),
          },
          "generate_image failed",
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
