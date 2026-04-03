export interface QueueTask {
  index: number;
  kind: "task" | "slash" | "stop";
  content: string;
  preview: string;
  lineCount: number;
}

export function parseQueue(raw: string): QueueTask[] {
  const blocks = raw.split("\n---\n");
  const tasks: QueueTask[] = [];
  let index = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split("\n")[0];
    let kind: QueueTask["kind"];

    if (firstLine.toUpperCase() === "STOP") {
      kind = "stop";
    } else if (firstLine.startsWith("/")) {
      kind = "slash";
    } else {
      kind = "task";
    }

    tasks.push({
      index: index++,
      kind,
      content: trimmed,
      preview: firstLine,
      lineCount: trimmed.split("\n").length,
    });
  }

  return tasks;
}

export function serializeQueue(tasks: QueueTask[]): string {
  return tasks.map((t) => t.content).join("\n---\n");
}
