// B2 (2026-09-24 review fix): `runOpencodeProcessLifecycle`'s teardown guarantees, exercised
// against a FAKE `OpencodeSubprocess` (same convention `tests/session-runner-cancel.test.ts`'s
// `fakeProc()` uses for the claude path) — no real `opencode` binary, no real timers beyond
// what each test explicitly overrides via `sigkillGraceMs`.

import { afterEach, describe, expect, test } from "bun:test";
import {
  runOpencodeProcessLifecycle,
  type OpencodeSubprocess,
} from "../server/mcp/opencode-runner.ts";
import { __resetActiveProcsForTests, activeSessionCount } from "../server/mcp/session-runner.ts";

afterEach(() => {
  __resetActiveProcsForTests();
});

function emptyStderr(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** A fake process whose stdout reader ALWAYS rejects on `.read()` — simulates the failure
 *  shape B2 fixes: an exception escaping the read loop for a reason other than an idle
 *  timeout. `kill()` resolves `.exited` immediately for SIGTERM unless `ignoresSigterm` is
 *  set, in which case only SIGKILL resolves it — letting one fake drive both B2 test cases. */
function fakeThrowingProc(opts: { ignoresSigterm?: boolean } = {}) {
  const kills: string[] = [];
  let exitCode: number | null = null;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });
  const proc = {
    get exitCode() {
      return exitCode;
    },
    stdout: {
      getReader: () => ({
        read: () => Promise.reject(new Error("boom: reader crashed")),
        releaseLock: () => {},
      }),
    },
    stderr: emptyStderr(),
    exited,
    kill(signal: string) {
      kills.push(signal);
      if (signal === "SIGKILL" || !opts.ignoresSigterm) {
        exitCode = signal === "SIGKILL" ? 137 : 143;
        resolveExited(exitCode);
      }
      // ignoresSigterm + SIGTERM: deliberately does nothing, simulating a child that
      // swallows the signal — only SIGKILL (unblockable) actually terminates it.
    },
  };
  return { proc: proc as unknown as OpencodeSubprocess, kills };
}

describe("runOpencodeProcessLifecycle — teardown guarantees (B2)", () => {
  test("a reader throw propagates, but still clears timers, untracks and kills the child", async () => {
    const { proc, kills } = fakeThrowingProc();
    expect(activeSessionCount()).toBe(0);

    const call = runOpencodeProcessLifecycle(proc, {
      jobId: "job-1",
      cwd: "/tmp",
      model: "deepseek-v4.1-flash",
      backend: "iu",
      tool: "dispatch",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      turnsRef: { current: 0 },
    });

    await expect(call).rejects.toThrow("boom: reader crashed");
    // Flush the microtask queue once more — `proc.exited.finally(untrack)` and this
    // function's own rejection are two independent continuations off the same synchronous
    // `resolveExited` call inside the `finally` block; give both a tick to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(kills).toEqual(["SIGTERM"]);
    expect(activeSessionCount()).toBe(0);
  });

  test("a SIGTERM-ignoring child still gets SIGKILL after the (test-shortened) grace period", async () => {
    const { proc, kills } = fakeThrowingProc({ ignoresSigterm: true });

    const call = runOpencodeProcessLifecycle(proc, {
      jobId: "job-2",
      cwd: "/tmp",
      model: "deepseek-v4.1-flash",
      backend: "iu",
      tool: "dispatch",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      turnsRef: { current: 0 },
      sigkillGraceMs: 20,
    });

    await expect(call).rejects.toThrow("boom: reader crashed");
    expect(kills).toEqual(["SIGTERM"]);

    // The escalation timer (20ms) fires after this function has already rejected — wait
    // past it, then confirm SIGKILL followed.
    await new Promise((r) => setTimeout(r, 60));
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(activeSessionCount()).toBe(0);
  });

  test("an already-exited process is never signalled twice", async () => {
    const kills: string[] = [];
    const proc = {
      exitCode: 0,
      stdout: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
      stderr: emptyStderr(),
      exited: Promise.resolve(0),
      kill(signal: string) {
        kills.push(signal);
      },
    } as unknown as OpencodeSubprocess;

    const result = await runOpencodeProcessLifecycle(proc, {
      jobId: "job-3",
      cwd: "/tmp",
      model: "deepseek-v4.1-flash",
      backend: "iu",
      tool: "dispatch",
      iuOpenaiBase: "https://iu.example.com/openai/v1",
      turnsRef: { current: 0 },
    });

    expect(result.exitCode).toBe(0);
    expect(kills).toEqual([]); // forceKill's exitCode-!==-null guard makes this a no-op
    expect(activeSessionCount()).toBe(0);
  });
});
