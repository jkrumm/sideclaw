// Replaces tests/deployment-plist.test.ts and tests/makefile-poll-ceiling.test.ts, both of
// which guarded an invariant that no longer exists: "the plist's ExitTimeOut exceeds the app's
// drain window." That was only ever true because launchd's ExitTimeOut used to be read as
// whatever the tracked plist said. It measurably isn't — launchd hard-caps it at 60s regardless
// (server/lib/shutdown.ts's two-window note) — so `make reload` no longer waits on that timer
// at all (POST /api/shutdown, a self-initiated exit). What still has to hold is the NEW
// invariant this file guards instead: the signal-initiated window (the one path still bounded
// by launchd's real signal-and-wait clock) has to stay under that 60s cap, with real margin for
// the post-decision flush on top — and the tracked plist should say exactly what the measured
// cap is, not a number that implies more headroom than launchd will ever actually grant.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHD_HARD_EXIT_TIMEOUT_MS,
  SHUTDOWN_FLUSH_MS,
  SIGNAL_DRAIN_GRACE_MS,
} from "../server/lib/shutdown.ts";

function readExitTimeOutSeconds(): number {
  const plistPath = join(import.meta.dir, "..", "com.jkrumm.sideclaw-server.plist");
  const xml = readFileSync(plistPath, "utf-8");
  const match = xml.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
  const seconds = match?.[1];
  if (!seconds) throw new Error("com.jkrumm.sideclaw-server.plist has no ExitTimeOut key");
  return parseInt(seconds, 10);
}

describe("signal-initiated drain window", () => {
  test("SIGNAL_DRAIN_GRACE_MS + SHUTDOWN_FLUSH_MS stays under launchd's measured hard cap, with real margin", () => {
    const signalWindowMs = SIGNAL_DRAIN_GRACE_MS + SHUTDOWN_FLUSH_MS;
    expect(signalWindowMs).toBeLessThan(LAUNCHD_HARD_EXIT_TIMEOUT_MS);
    // "Real margin", not a hairline pass — at least 10s of slack under the cap.
    expect(LAUNCHD_HARD_EXIT_TIMEOUT_MS - signalWindowMs).toBeGreaterThanOrEqual(10_000);
  });
});

describe("com.jkrumm.sideclaw-server.plist ExitTimeOut", () => {
  test("is set to exactly launchd's measured cap — a higher value is silently capped, not honored", () => {
    const exitTimeoutMs = readExitTimeOutSeconds() * 1000;
    expect(exitTimeoutMs).toBe(LAUNCHD_HARD_EXIT_TIMEOUT_MS);
  });
});

describe("Makefile PID-poll — unbounded (HTTP_DRAIN_GRACE_MS is now Infinity)", () => {
  /** `reload` and `install-agent`'s drain-wait loops used to share a numeric `[ $$i -lt N ]`
   *  ceiling, pinned here against `HTTP_DRAIN_GRACE_MS`. That constant is now `Infinity`
   *  (owner decision, 2026-09-12 — see shutdown.ts), so a finite ceiling here would silently
   *  reintroduce the exact bound this file used to guard against having. */
  function readMakefile(): string {
    return readFileSync(join(import.meta.dir, "..", "Makefile"), "utf-8");
  }

  test("neither loop has a numeric poll ceiling", () => {
    expect(readMakefile()).not.toMatch(/\[\s*\$\$i\s+-lt\s+\d+\s*\]/);
  });

  test("both loops print a progress line at least once a minute while waiting", () => {
    const matches = [...readMakefile().matchAll(/\$\$\(\(i % (\d+)\)\) -eq 0/g)];
    expect(matches.length).toBe(2);
    for (const m of matches) {
      // Ticks are 0.5s each — see the `sleep 0.5` in the same loops.
      expect(parseInt(m[1] as string, 10) * 500).toBeLessThanOrEqual(60_000);
    }
  });
});
