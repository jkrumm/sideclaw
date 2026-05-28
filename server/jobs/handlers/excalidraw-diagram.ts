import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { runSession, zodValidator } from "../../mcp/session-runner.ts";
import { logger } from "../../mcp/logger.ts";
import { hydrateExcalidrawSkeleton } from "../../lib/excalidraw-hydrate.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";

// ── Input schema ──────────────────────────────────────────────────────────────

export const EXCALIDRAW_DIAGRAM_INPUT = z.object({
  prompt: z
    .string()
    .min(10)
    .describe(
      "The design brief: subject of the diagram, depth (conceptual vs technical), the visual patterns " +
        "for each major concept (fan-out / convergence / timeline / etc.), zone groupings, and any " +
        "evidence artifacts to include. Describe roles, not hex colors — the worker has a curated palette.",
    ),
  outputPath: z
    .string()
    .describe(
      "Absolute path where the `.excalidraw` file will be written. Must end in `.excalidraw`. Parent " +
        "directory will be created if missing. In `extend` mode, the file at this path is read first and " +
        "passed to the worker as a baseline.",
    ),
  mode: z
    .enum(["create", "extend"])
    .optional()
    .describe(
      "`create` (default): emit a fresh diagram and write to `outputPath` (overwriting if it exists). " +
        "`extend`: read the existing diagram at `outputPath`, pass it to the worker as context, and write " +
        "the worker's complete new skeleton over the file.",
    ),
});

export type ExcalidrawDiagramParams = z.infer<typeof EXCALIDRAW_DIAGRAM_INPUT>;

// ── Output schema ─────────────────────────────────────────────────────────────

export const EXCALIDRAW_DIAGRAM_OUTPUT = z.object({
  outputPath: z.string().describe("Absolute path of the written `.excalidraw` file."),
  elementCount: z.number().describe("Number of hydrated elements in the written file."),
  viewport: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable()
    .describe("The cameraUpdate hint the worker emitted, if any. Null when not provided."),
  hydratedBytes: z.number().describe("Size of the written `.excalidraw` file in bytes."),
  rationale: z
    .string()
    .describe("One- or two-sentence summary of the design choices the worker made."),
});

export type ExcalidrawDiagramOutput = z.infer<typeof EXCALIDRAW_DIAGRAM_OUTPUT>;

// ── Worker payload schema (what the Kimi worker emits as its final JSON) ──────

const WORKER_OUTPUT = z.object({
  rationale: z
    .string()
    .describe("One or two sentences explaining the design choices made for this diagram."),
  elements: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .describe(
      "Array of Excalidraw element skeletons. See the skill prompt for the schema. May include " +
        "pseudo-elements (cameraUpdate, delete, restoreCheckpoint).",
    ),
});

const WORKER_JSON_SCHEMA = z.toJSONSchema(WORKER_OUTPUT);

type WorkerOutput = z.infer<typeof WORKER_OUTPUT>;

// ── Skill prompt loader ───────────────────────────────────────────────────────

async function loadSkillPrompt(): Promise<string> {
  const skillPath = join(import.meta.dir, "../../skills/excalidraw-diagram.md");
  if (!existsSync(skillPath)) {
    throw new Error(`excalidraw-diagram skill prompt not found at ${skillPath}`);
  }
  return Bun.file(skillPath).text();
}

function buildPrompt(skill: string, userPrompt: string, existing: string | null): string {
  const briefBlock = `\n## Design brief\n\n${userPrompt}\n`;
  const existingBlock = existing
    ? `\n## Existing diagram (extend mode)\n\nThe file at the output path currently contains the JSON ` +
      `below (fully hydrated). Use it as context and emit a complete new skeleton — your output ` +
      `replaces this file. Preserve what's worth keeping by re-emitting it in skeleton form; remove ` +
      `what should go; add what's new.\n\n\`\`\`json\n${existing}\n\`\`\`\n`
    : "";
  const envelope =
    `\n## Output envelope\n\n` +
    `Your final message must be a single JSON object of the form:\n\n` +
    `\`\`\`json\n{ "rationale": "<one or two sentences>", "elements": [ ... skeleton elements ... ] }\n\`\`\`\n\n` +
    `The \`elements\` array follows the skeleton schema in this skill. The host hydrates and writes ` +
    `the file. Do not include \`version\`/\`versionNonce\`/\`seed\`/\`boundElements\` on elements — ` +
    `those are computed downstream.\n`;
  return `${skill}\n${briefBlock}${existingBlock}${envelope}`;
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function runExcalidrawDiagram(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<ExcalidrawDiagramOutput> {
  const params = parseParams(EXCALIDRAW_DIAGRAM_INPUT, rawParams);
  const { prompt: userPrompt, outputPath } = params;
  const mode = params.mode ?? "create";

  if (!isAbsolute(outputPath)) {
    throw new Error(`outputPath must be absolute: ${outputPath}`);
  }
  if (!outputPath.endsWith(".excalidraw")) {
    throw new Error(`outputPath must end in .excalidraw: ${outputPath}`);
  }

  const parentDir = dirname(outputPath);
  await mkdir(parentDir, { recursive: true });

  let existing: string | null = null;
  if (mode === "extend") {
    if (!existsSync(outputPath)) {
      throw new Error(`extend mode requires an existing file at ${outputPath}`);
    }
    existing = await Bun.file(outputPath).text();
  }

  const skill = await loadSkillPrompt();
  const prompt = buildPrompt(skill, userPrompt, existing);

  logger.info(
    { event: "excalidraw_diagram.start", outputPath, mode, promptChars: prompt.length },
    "excalidraw_diagram starting",
  );

  // Worker runs read-only — it only emits JSON. The handler hydrates and writes.
  // cwd = parent directory so the worker has a sensible working dir for any
  // ad-hoc reads (no globals from random project repos leak in).
  const result = await runSession<WorkerOutput>({
    cwd: parentDir,
    prompt,
    tool: "excalidraw-diagram",
    model: "Kimi-K2.6",
    jsonSchema: WORKER_JSON_SCHEMA,
    maxTurns: 40,
    timeoutMs: 15 * 60 * 1000,
    readOnly: true,
    settingSources: "user,project",
    validate: zodValidator(WORKER_OUTPUT),
    onActivity: onProgress,
  });

  if (!result.ok || !result.data) {
    throw new Error(result.error ?? "excalidraw_diagram worker produced no result");
  }

  const { elements, rationale } = result.data;
  const hydrated = await hydrateExcalidrawSkeleton({ skeleton: elements });
  const bytes = JSON.stringify(hydrated.file, null, 2);
  await writeFile(outputPath, bytes, "utf-8");

  logger.info(
    {
      event: "excalidraw_diagram.end",
      outputPath,
      elementCount: hydrated.elementCount,
      hydratedBytes: bytes.length,
    },
    "excalidraw_diagram done",
  );

  return {
    outputPath,
    elementCount: hydrated.elementCount,
    viewport: hydrated.viewport,
    hydratedBytes: bytes.length,
    rationale,
  };
}
