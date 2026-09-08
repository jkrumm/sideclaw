// Guards the exact drift that broke the drain: com.jkrumm.sideclaw-server.plist's
// `ExitTimeOut` is read once at `launchctl bootstrap` (`make install-agent`) and never again
// by `make reload` (`launchctl kill` only signals the already-loaded job definition — verified
// live: `launchctl print gui/$(id -u)/com.jkrumm.sideclaw-server` still showed `exit timeout =
// 5` after SHUTDOWN_GRACE_MS had long since moved past launchd's 20 s default, because the
// tracked plist's ExitTimeOut edit had not gone through `make install-agent` yet). If
// ExitTimeOut ever drops back to at or below SHUTDOWN_GRACE_MS + SHUTDOWN_FLUSH_MS, launchd's
// own timer would SIGKILL the process mid-drain before the app-level flush ever gets there —
// this test fails loudly instead of that showing up as an orphaned worker after a reboot.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHUTDOWN_FLUSH_MS, SHUTDOWN_GRACE_MS } from "../server/lib/shutdown.ts";

function readExitTimeOutSeconds(): number {
  const plistPath = join(import.meta.dir, "..", "com.jkrumm.sideclaw-server.plist");
  const xml = readFileSync(plistPath, "utf-8");
  const match = xml.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
  const seconds = match?.[1];
  if (!seconds) throw new Error("com.jkrumm.sideclaw-server.plist has no ExitTimeOut key");
  return parseInt(seconds, 10);
}

describe("com.jkrumm.sideclaw-server.plist ExitTimeOut", () => {
  test("exceeds SHUTDOWN_GRACE_MS + SHUTDOWN_FLUSH_MS with real margin", () => {
    const exitTimeoutMs = readExitTimeOutSeconds() * 1000;
    const drainWindowMs = SHUTDOWN_GRACE_MS + SHUTDOWN_FLUSH_MS;
    expect(exitTimeoutMs).toBeGreaterThan(drainWindowMs);
  });
});
