// `server/lib/scope.ts` — the review scope grammar shared by review.ts and ocr.ts, plus the
// review-side helpers built on it (fallow command/block, validateScope's range halves).

import { describe, expect, test } from "bun:test";
import { isPathScope, splitRange } from "../server/lib/scope.ts";
import {
  FALLOW_FAILED_PREFIX,
  fallowCommand,
  renderFallowBlock,
  validateScope,
} from "../server/jobs/handlers/review.ts";
import { ocrModeArgs } from "../server/lib/ocr.ts";

describe("splitRange / isPathScope", () => {
  test("two- and three-dot ranges split, open sides stay empty", () => {
    expect(splitRange("main..HEAD")).toEqual({ from: "main", to: "HEAD" });
    expect(splitRange("main...feature")).toEqual({ from: "main", to: "feature" });
    expect(splitRange("main..")).toEqual({ from: "main", to: "" });
    expect(splitRange("HEAD~3")).toBeNull();
  });

  test("paths vs refs", () => {
    expect(isPathScope("/abs/file.ts")).toBe(true);
    expect(isPathScope("src/foo.ts")).toBe(true);
    expect(isPathScope("HEAD~3")).toBe(false);
    expect(isPathScope("main..HEAD")).toBe(false);
  });
});

describe("validateScope range halves", () => {
  test("a leading '-' on either half of a range is refused", () => {
    expect(() => validateScope("HEAD..-x")).toThrow(/must not start with '-'/);
    expect(() => validateScope("-x..HEAD")).toThrow(/must not start with '-'/);
    expect(() => validateScope("HEAD~2..HEAD")).not.toThrow();
  });
});

describe("ocrModeArgs open ranges", () => {
  test("`main..` means main..HEAD, an empty left side has no OCR mode", () => {
    expect(ocrModeArgs("main..")).toEqual(["--from", "main", "--to", "HEAD"]);
    expect(ocrModeArgs("..HEAD")).toBeNull();
  });
});

describe("fallowCommand / renderFallowBlock", () => {
  test("skip never invokes fallow", () => {
    expect(fallowCommand({ kind: "skip" })).not.toContain("fallow review");
  });

  test("auto keeps the remote guard and passes no --base", () => {
    const cmd = fallowCommand({ kind: "auto" });
    expect(cmd).toContain("git remote -v");
    expect(cmd).not.toContain("--base");
  });

  test("base passes --base and reports a failure instead of swallowing it", () => {
    const cmd = fallowCommand({ kind: "base", ref: "HEAD~2" });
    expect(cmd).toContain("--base HEAD~2");
    expect(cmd).not.toContain("git remote -v");
    expect(cmd).toContain(FALLOW_FAILED_PREFIX);
  });

  test("block rendering: absent, crashed, brief", () => {
    expect(renderFallowBlock("")).toBe("fallow: not available or skipped.");
    expect(renderFallowBlock(`${FALLOW_FAILED_PREFIX} (exit 2): boom`)).toContain(
      "no static-analysis input",
    );
    expect(renderFallowBlock("Decisions to make (1)")).toContain("fallow review brief:");
  });
});
