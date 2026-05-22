import { existsSync } from "node:fs";

/**
 * Locate a usable Chrome/Chromium binary on this Mac.
 *
 * Checked in order: system Google Chrome, system Chromium, then the Playwright
 * "Chrome for Testing" cache. Shared by kiosk mode (`routes/kiosk.ts`) and the
 * SVG rasterizer (`lib/image.ts`). Returns null when nothing is found.
 */
export async function findChrome(): Promise<string | null> {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Also check Playwright Chrome for Testing
  const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
  try {
    const glob = new Bun.Glob("chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium");
    for await (const match of glob.scan(base)) {
      const full = `${base}/${match}`;
      if (existsSync(full)) return full;
    }
  } catch {
    // Playwright not installed — skip
  }

  return null;
}
