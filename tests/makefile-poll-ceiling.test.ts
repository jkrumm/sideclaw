// Guards the fourth face of the same number `tests/deployment-plist.test.ts` pins: the
// Makefile's PID-poll ceiling (5520 half-second ticks, shared by `reload` and `install-agent`
// — see the comment above `reload`'s target) has to outlast launchd's own `ExitTimeOut`, or a
// `kickstart`/`bootstrap` fired after the poll gives up can still land on a process launchd
// hasn't force-killed yet. Nothing type-checks a Makefile literal against a TypeScript
// constant, so if either number moves without the other, this is the test that notices.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readExitTimeOutSeconds(): number {
  const plistPath = join(import.meta.dir, "..", "com.jkrumm.sideclaw-server.plist");
  const xml = readFileSync(plistPath, "utf-8");
  const match = xml.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
  const seconds = match?.[1];
  if (!seconds) throw new Error("com.jkrumm.sideclaw-server.plist has no ExitTimeOut key");
  return parseInt(seconds, 10);
}

/** Every `[ $$i -lt N ]` poll-ceiling literal in the Makefile's drain-wait loops (`reload` and
 *  `install-agent` both carry one). Returns their tick counts in ms — asserted below to all
 *  agree with each other AND outlast ExitTimeOut, since the two targets are meant to share one
 *  ceiling, not drift into two silently different numbers. */
function readPollCeilingsMs(): number[] {
  const makefile = readFileSync(join(import.meta.dir, "..", "Makefile"), "utf-8");
  const matches = [...makefile.matchAll(/\[\s*\$\$i\s+-lt\s+(\d+)\s*\]/g)];
  if (matches.length === 0) throw new Error("Makefile has no `-lt N` poll-ceiling literal");
  // Ticks are 0.5s each — see the `sleep 0.5` in the same loops.
  return matches.map((m) => parseInt(m[1] as string, 10) * 500);
}

describe("Makefile PID-poll ceiling", () => {
  test("every poll ceiling in the Makefile agrees with the others", () => {
    const ceilings = readPollCeilingsMs();
    expect(new Set(ceilings).size).toBe(1);
  });

  test("outlasts the plist's ExitTimeOut, the true worst case for how long the old process can stay alive", () => {
    const exitTimeoutMs = readExitTimeOutSeconds() * 1000;
    for (const ceilingMs of readPollCeilingsMs()) {
      expect(ceilingMs).toBeGreaterThan(exitTimeoutMs);
    }
  });
});
