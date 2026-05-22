// Deterministic structural parse of an .excalidraw JSON file. This is the
// *ground truth* the vision model can't always recover (frame membership,
// label↔shape pairing, arrow bindings) — see the read-drawing schema rules in
// dotfiles/skills/read-drawing/SKILL.md. The vision read is supplementary; this
// parse is authoritative for structure.

export interface ExComponent {
  type: string; // "rectangle" | "diamond" | "ellipse" | ...
  role: string; // semantic role inferred from type
  label: string;
  frame: string | null;
}

export interface ExFlow {
  from: string;
  to: string;
  label: string | null;
  dashed: boolean;
}

export interface ExStructure {
  title: string | null;
  components: ExComponent[];
  flows: ExFlow[];
  groups: string[][];
  frames: string[];
  annotations: string[];
}

interface ExElement {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  containerId?: string | null;
  frameId?: string | null;
  groupIds?: string[];
  strokeStyle?: string;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  isDeleted?: boolean;
}

const SHAPE_TYPES = new Set(["rectangle", "diamond", "ellipse", "image"]);

const ROLE_BY_TYPE: Record<string, string> = {
  diamond: "decision",
  ellipse: "actor/endpoint",
  rectangle: "process/component",
  image: "image",
};

export function parseExcalidraw(jsonText: string): ExStructure {
  let parsed: { elements?: ExElement[] };
  try {
    parsed = JSON.parse(jsonText) as { elements?: ExElement[] };
  } catch (err) {
    throw new Error(
      `Invalid .excalidraw JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }

  const elements = (parsed.elements ?? []).filter((e) => !e.isDeleted);
  const byId = new Map<string, ExElement>(elements.map((e) => [e.id, e]));

  // text.containerId → the label of that container
  const containerLabel = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId && el.text) {
      containerLabel.set(el.containerId, el.text.trim());
    }
  }

  // Frame id → name
  const frameName = new Map<string, string>();
  const frames: string[] = [];
  for (const el of elements) {
    if (el.type === "frame") {
      const name = (el as ExElement & { name?: string }).name?.trim() || "Frame";
      frameName.set(el.id, name);
      frames.push(name);
    }
  }

  const labelOf = (id: string | undefined | null): string => {
    if (!id) return "?";
    const el = byId.get(id);
    if (!el) return "?";
    return containerLabel.get(id) ?? el.text?.trim() ?? frameName.get(id) ?? el.type;
  };

  // Components: drawable shapes (sorted top-to-bottom for reading order)
  const components: ExComponent[] = elements
    .filter((e) => SHAPE_TYPES.has(e.type))
    .toSorted((a, b) => (a.y ?? 0) - (b.y ?? 0))
    .map((e) => ({
      type: e.type,
      role: ROLE_BY_TYPE[e.type] ?? e.type,
      label: containerLabel.get(e.id) ?? e.text?.trim() ?? "(unlabeled)",
      frame: e.frameId ? (frameName.get(e.frameId) ?? null) : null,
    }));

  // Flows: arrows/lines with bindings
  const flows: ExFlow[] = elements
    .filter((e) => (e.type === "arrow" || e.type === "line") && (e.startBinding || e.endBinding))
    .map((e) => ({
      from: labelOf(e.startBinding?.elementId),
      to: labelOf(e.endBinding?.elementId),
      label: containerLabel.get(e.id) ?? null,
      dashed: e.strokeStyle === "dashed",
    }));

  // Groups: shapes sharing a groupId belong to the same logical component
  const groupMap = new Map<string, Set<string>>();
  for (const el of elements) {
    if (!el.groupIds?.length) continue;
    const label = containerLabel.get(el.id) ?? el.text?.trim();
    if (!label) continue;
    for (const gid of el.groupIds) {
      const set = groupMap.get(gid) ?? new Set<string>();
      set.add(label);
      groupMap.set(gid, set);
    }
  }
  const groups = [...groupMap.values()].map((s) => [...s]).filter((g) => g.length > 1);

  // Standalone text (no containerId, not an arrow label) → annotations / title.
  const arrowIds = new Set(
    elements.filter((e) => e.type === "arrow" || e.type === "line").map((e) => e.id),
  );
  const standalone = elements.filter(
    (e) =>
      e.type === "text" &&
      !e.containerId &&
      e.text &&
      ![...containerLabel.keys()].includes(e.id) &&
      !arrowIds.has(e.id),
  );
  // Title heuristic: largest font, else topmost.
  const titleEl = standalone.toSorted(
    (a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || (a.y ?? 0) - (b.y ?? 0),
  )[0];
  const title = titleEl?.text?.trim() ?? null;
  const annotations = standalone
    .filter((e) => e.id !== titleEl?.id)
    .map((e) => (e.text ?? "").trim());

  return { title, components, flows, groups, frames, annotations };
}

/** Render the parsed structure as a compact text block to feed the vision model
 * alongside the image — covers the model's frame-flattening weakness. */
export function formatStructureForPrompt(s: ExStructure): string {
  const lines: string[] = [];
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.frames.length) lines.push(`Frames/sections: ${s.frames.join(", ")}`);
  if (s.components.length) {
    lines.push("Components:");
    for (const c of s.components) {
      lines.push(`  - [${c.role}] "${c.label}"${c.frame ? ` (in frame: ${c.frame})` : ""}`);
    }
  }
  if (s.flows.length) {
    lines.push("Flows:");
    for (const f of s.flows) {
      lines.push(
        `  - "${f.from}" -> "${f.to}"${f.label ? ` [${f.label}]` : ""}${f.dashed ? " (dashed/optional)" : ""}`,
      );
    }
  }
  if (s.groups.length) {
    lines.push("Groups (same logical component):");
    for (const g of s.groups) lines.push(`  - ${g.join(" + ")}`);
  }
  if (s.annotations.length) lines.push(`Annotations: ${s.annotations.join("; ")}`);
  return lines.join("\n");
}
