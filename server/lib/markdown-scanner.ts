import { readdirSync } from "fs";
import { join, relative } from "path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "vendor",
]);

const IGNORE_FILES = new Set(["sc-note.md", "sc-queue.md"]);

export function scanMarkdownFiles(repoPath: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORE_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".md") && !IGNORE_FILES.has(entry.name)) {
        files.push(relative(repoPath, join(dir, entry.name)));
      }
    }
  }

  walk(repoPath);
  return files.toSorted();
}
