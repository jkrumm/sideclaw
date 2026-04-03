import Elysia, { t } from "elysia";
import { existsSync } from "fs";

const ALLOWED_ORIGINS = ["http://sideclaw.local", "http://localhost"];

async function findChrome(): Promise<string | null> {
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

export const kioskRoute = new Elysia().get(
  "/api/open-kiosk",
  async ({ query, error }) => {
    const { url } = query;
    if (!ALLOWED_ORIGINS.some((o) => url.startsWith(o))) {
      return error(400, { ok: false, error: "URL must be a local sideclaw URL" });
    }

    const chrome = await findChrome();
    if (!chrome) {
      return error(503, { ok: false, error: "No Chrome binary found" });
    }

    // Isolated profile so kiosk doesn't interfere with existing Chrome sessions
    // Exit kiosk: Cmd+Q (Esc does NOT work in Chrome kiosk)
    Bun.spawn([chrome, "--kiosk", "--user-data-dir=/tmp/sideclaw-kiosk", url], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    return { ok: true };
  },
  {
    query: t.Object({ url: t.String() }),
  },
);
