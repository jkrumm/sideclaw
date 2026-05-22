import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { findChrome } from "./chrome.ts";

// Cap the longest logical side; combined with --force-device-scale-factor=2 the
// actual PNG tops out at 2x this. Plenty of resolution for a vision model, while
// keeping the base64 payload small.
const MAX_SIDE = 1600;
const SCALE = 2;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface Dims {
  width: number;
  height: number;
}

/** Read the intended render size from the SVG root element. Prefers viewBox
 * (the unscaled coordinate space) over width/height (often a 2x export). */
function svgDimensions(svg: string): Dims {
  const tagMatch = svg.match(/<svg[^>]*>/i);
  const tag = tagMatch ? tagMatch[0] : svg;

  const viewBox = tag.match(/viewBox="([^"]+)"/i);
  if (viewBox) {
    const parts = viewBox[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const w = tag.match(/\bwidth="([\d.]+)/i);
  const h = tag.match(/\bheight="([\d.]+)/i);
  if (w && h) {
    const width = Number(w[1]);
    const height = Number(h[1]);
    if (width > 0 && height > 0) return { width, height };
  }

  return { width: 1024, height: 768 };
}

function capDimensions({ width, height }: Dims): Dims {
  const longest = Math.max(width, height);
  if (longest <= MAX_SIDE) return { width: Math.round(width), height: Math.round(height) };
  const factor = MAX_SIDE / longest;
  return { width: Math.round(width * factor), height: Math.round(height * factor) };
}

/**
 * Rasterize an SVG to PNG using headless Chrome — the only method that resolves
 * web fonts faithfully while preserving full aspect (qlmanage crops, svglib
 * renders text as tofu). Wraps the SVG in a minimal HTML at native size and
 * screenshots it. Returns the temp PNG path; caller owns cleanup.
 */
export async function rasterizeSvg(svgPath: string): Promise<string> {
  if (!existsSync(svgPath)) throw new Error(`SVG not found: ${svgPath}`);
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error(
      "No Chrome/Chromium binary found for SVG rasterization. Install Google Chrome or Playwright chromium.",
    );
  }

  const svg = await Bun.file(svgPath).text();
  const { width, height } = capDimensions(svgDimensions(svg));

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const htmlPath = join(tmpdir(), `sideclaw-raster-${stamp}.html`);
  const pngPath = join(tmpdir(), `sideclaw-raster-${stamp}.png`);

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:#fff}` +
    `img{display:block;width:${width}px;height:${height}px}</style></head>` +
    `<body><img src="file://${svgPath}"></body></html>`;
  await Bun.write(htmlPath, html);

  try {
    const proc = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--force-device-scale-factor=${SCALE}`,
        `--window-size=${width},${height}`,
        "--default-background-color=FFFFFFFF",
        `--screenshot=${pngPath}`,
        `file://${htmlPath}`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0 || !existsSync(pngPath)) {
      throw new Error(`Chrome rasterization failed (exit ${code}) for ${svgPath}`);
    }
    return pngPath;
  } finally {
    await unlink(htmlPath).catch(() => {});
  }
}

/**
 * Load an image path as base64 + mime for the vision transport. SVGs are
 * rasterized via headless Chrome first (most vision models reject raw SVG); the
 * intermediate PNG is cleaned up. Other formats are read as-is.
 */
export async function loadImageAsBase64(
  path: string,
): Promise<{ base64: string; mimeType: string }> {
  if (!existsSync(path)) throw new Error(`Image not found: ${path}`);
  const ext = extname(path).toLowerCase();

  if (ext === ".svg") {
    const pngPath = await rasterizeSvg(path);
    try {
      const bytes = await Bun.file(pngPath).bytes();
      return { base64: Buffer.from(bytes).toString("base64"), mimeType: "image/png" };
    } finally {
      await unlink(pngPath).catch(() => {});
    }
  }

  const bytes = await Bun.file(path).bytes();
  return {
    base64: Buffer.from(bytes).toString("base64"),
    mimeType: MIME_BY_EXT[ext] ?? "image/png",
  };
}
