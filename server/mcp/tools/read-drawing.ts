import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.ts";
import { mcpHeartbeat } from "../session-runner.ts";
import { visionRead } from "../../lib/iu-openai.ts";
import { loadImageAsBase64 } from "../../lib/image.ts";
import { parseExcalidraw, formatStructureForPrompt } from "../../lib/excalidraw.ts";

const COMPONENT_SCHEMA = z.object({
  type: z.string(),
  role: z.string(),
  label: z.string(),
  frame: z.string().nullable(),
});

const FLOW_SCHEMA = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().nullable(),
  dashed: z.boolean(),
});

const STRUCTURE_SCHEMA = z.object({
  title: z.string().nullable(),
  components: z.array(COMPONENT_SCHEMA),
  flows: z.array(FLOW_SCHEMA),
  groups: z.array(z.array(z.string())),
  frames: z.array(z.string()),
  annotations: z.array(z.string()),
});

const READ_DRAWING_OUTPUT = z.object({
  synthesis: z.string().describe("Merged prose synthesis (vision gestalt + JSON ground truth)."),
  structure: STRUCTURE_SCHEMA.describe("Deterministic structure parsed from the .excalidraw JSON."),
  svgPath: z.string().nullable().describe("Resolved .svg path, or null if absent."),
  excalidrawPath: z.string().nullable().describe("Resolved .excalidraw path, or null if absent."),
  model: z.string().describe("Vision model used."),
  latencyMs: z.number().describe("End-to-end call latency in ms."),
  usage: z
    .object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() })
    .optional()
    .describe("Token usage reported by the model, if present."),
});

let promptTemplate: string | null = null;
async function loadSynthesisPrompt(): Promise<string> {
  if (promptTemplate) return promptTemplate;
  const skillPath = join(import.meta.dir, "../../skills/read-drawing.md");
  if (!existsSync(skillPath))
    throw new Error(`read-drawing skill prompt not found at ${skillPath}`);
  promptTemplate = await Bun.file(skillPath).text();
  return promptTemplate;
}

/** Resolve <base>.svg and <base>.excalidraw from any of: base path, .svg, or .excalidraw. */
function resolvePaths(input: string): { svgPath: string | null; excalidrawPath: string | null } {
  const base = input.replace(/\.(svg|excalidraw)$/i, "");
  const svgPath = existsSync(`${base}.svg`) ? `${base}.svg` : null;
  const excalidrawPath = existsSync(`${base}.excalidraw`) ? `${base}.excalidraw` : null;
  return { svgPath, excalidrawPath };
}

export function registerReadDrawingTool(server: McpServer): void {
  server.registerTool(
    "read_drawing",
    {
      title: "Read Excalidraw Drawing",
      description: `Interpret a paired Excalidraw drawing: rasterize+read the .svg AND parse the .excalidraw JSON for exact structure, merged into one synthesis.

WHEN TO CALL: to understand an Excalidraw diagram (.excalidraw + .svg pair). For arbitrary single images use read_image.
READ-ONLY: never modifies files. Safe to retry.
CWD: pass the base path, the .svg, or the .excalidraw — the pair is resolved automatically.
OUTPUT: \`synthesis\` is the merged prose; \`structure\` is the deterministic JSON parse (frames, bindings, groups) — the structural ground truth. At least one of .svg/.excalidraw must exist.`,
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute base path or a .svg/.excalidraw file. The pair is resolved automatically.",
          ),
        model: z.string().optional().describe('Vision model. Default "gemini-3-pro-preview".'),
      },
      outputSchema: READ_DRAWING_OUTPUT.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ path, model }, extra) => {
      const startMs = performance.now();
      const { svgPath, excalidrawPath } = resolvePaths(path);
      if (!svgPath && !excalidrawPath) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No .svg or .excalidraw found for: ${path}` }),
            },
          ],
          isError: true,
        };
      }
      logger.info(
        { event: "mcp.tool.start", tool: "read_drawing", svgPath, excalidrawPath, model },
        "read_drawing starting",
      );
      const stop = mcpHeartbeat(extra, "read_drawing");
      try {
        const structure = excalidrawPath
          ? parseExcalidraw(await Bun.file(excalidrawPath).text())
          : { title: null, components: [], flows: [], groups: [], frames: [], annotations: [] };

        let synthesis: string;
        let usedModel = model ?? "gemini-3-pro-preview";
        let latencyMs = 0;
        let usage;

        if (svgPath) {
          const { base64, mimeType } = await loadImageAsBase64(svgPath);
          const template = await loadSynthesisPrompt();
          const prompt = template.replace(
            "{{STRUCTURE}}",
            formatStructureForPrompt(structure) || "(no .excalidraw available)",
          );
          const result = await visionRead({
            imageBase64: base64,
            mimeType,
            prompt,
            model,
            tool: "read_drawing",
          });
          synthesis = result.text;
          usedModel = result.model;
          latencyMs = result.latencyMs;
          usage = result.usage;
        } else {
          // .excalidraw only — no image to read; synthesize from structure alone.
          usedModel = "structure-only";
          synthesis = `### Diagram (structure only — no .svg)\n\n${formatStructureForPrompt(structure)}`;
        }

        const out = {
          synthesis,
          structure,
          svgPath,
          excalidrawPath,
          model: usedModel,
          latencyMs,
          usage,
        };
        logger.info(
          {
            event: "mcp.tool.end",
            tool: "read_drawing",
            model: usedModel,
            components: structure.components.length,
            flows: structure.flows.length,
            durationMs: Math.round(performance.now() - startMs),
            tokens: usage?.totalTokens,
          },
          "read_drawing done",
        );
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out as Record<string, unknown>,
        };
      } catch (err) {
        logger.error(
          {
            event: "mcp.tool.end",
            tool: "read_drawing",
            error: String(err),
            durationMs: Math.round(performance.now() - startMs),
          },
          "read_drawing failed",
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
