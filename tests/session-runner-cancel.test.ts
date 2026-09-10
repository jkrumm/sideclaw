// terminateSessionsForJob (server/mcp/session-runner.ts) against fake procs injected via
// __registerProcForTests, so this never spawns a real `claude -p`. Mirrors the shape
// terminateActiveSessions (the process-wide drain kill) is already trusted to have, just
// scoped to one jobId.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __registerProcForTests,
  __resetActiveProcsForTests,
  terminateSessionsForJob,
} from "../server/mcp/session-runner.ts";

afterEach(() => {
  __resetActiveProcsForTests();
});

function fakeProc() {
  const kills: string[] = [];
  const proc = {
    exitCode: null as number | null,
    kill(signal: string) {
      kills.push(signal);
    },
  };
  return { proc: proc as unknown as ReturnType<typeof Bun.spawn>, kills };
}

describe("terminateSessionsForJob", () => {
  test("signals only the proc registered for the given jobId, not another job's", () => {
    const target = fakeProc();
    const other = fakeProc();
    __registerProcForTests(target.proc, "job-a");
    __registerProcForTests(other.proc, "job-b");

    const signalled = terminateSessionsForJob("job-a");

    expect(signalled).toBe(true);
    expect(target.kills).toEqual(["SIGTERM"]);
    expect(other.kills).toEqual([]);
  });

  test("returns false when the job has no live proc registered", () => {
    const signalled = terminateSessionsForJob("nothing-registered");
    expect(signalled).toBe(false);
  });

  test("skips a proc that already exited", () => {
    const exited = fakeProc();
    exited.proc.exitCode = 0;
    __registerProcForTests(exited.proc, "job-c");

    const signalled = terminateSessionsForJob("job-c");

    expect(signalled).toBe(false);
    expect(exited.kills).toEqual([]);
  });
});
