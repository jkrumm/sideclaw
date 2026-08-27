// Drift detection for the review pipeline's angle registry.
//
// An angle key appears in five places that have no compile-time link to each other: the
// label map, its prompt file on disk, the router's menu, the caller-facing `angles`
// description, and the synthesis prompt's allowed-`angle` list. Every failure mode below is
// silent at runtime — a missing prompt file throws inside a background job whose verdict
// simply never arrives, and an angle absent from the router's menu is filtered out of the
// router's pick with no log line. These are cheap string assertions precisely because the
// expensive alternative is noticing months later that a reviewer never ran.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import {
  ALL_ANGLE_LABELS,
  ROUTER_ANGLE_LABELS,
  REVIEW_INPUT,
  REVIEW_OUTPUT,
} from "../server/jobs/handlers/review.ts";

const SKILL_DIR = join(import.meta.dir, "../server/skills/review");
const read = (name: string) => readFileSync(join(SKILL_DIR, name), "utf8");

const ALL_KEYS = Object.keys(ALL_ANGLE_LABELS);
const ROUTER_KEYS = Object.keys(ROUTER_ANGLE_LABELS);

describe("review angle registry", () => {
  test("every angle has a prompt file with real content", () => {
    for (const key of ALL_KEYS) {
      const prompt = read(`${key}.md`);
      expect(prompt.length).toBeGreaterThan(500);
    }
  });

  test("every angle prompt carries the diff placeholder the handler substitutes", () => {
    // Without it the worker reviews nothing and confidently reports no findings.
    for (const key of ALL_KEYS) {
      expect(read(`${key}.md`)).toContain("[GIT_DIFF_COMMAND]");
    }
  });

  test("every angle prompt asks for the findings schema", () => {
    for (const key of ALL_KEYS) {
      expect(read(`${key}.md`)).toContain('"findings"');
    }
  });

  test("the router's menu lists exactly the router-only angles", () => {
    const router = read("router.md");
    for (const key of ROUTER_KEYS) {
      // Bulleted as `- **<key>** —`; the handler filters the router's pick against this map,
      // so an angle missing from the menu can never be selected.
      expect(router).toContain(`- **${key}**`);
    }
    // The floor angles are chosen deterministically; offering them to the router would let
    // it spend a slot re-picking one that already ran.
    for (const key of ALL_KEYS) {
      if (ROUTER_KEYS.includes(key)) continue;
      expect(router).not.toContain(`- **${key}**`);
    }
  });

  test("every angle is named in the caller-facing `angles` description", () => {
    const description = REVIEW_INPUT.shape.angles.description ?? "";
    for (const key of ALL_KEYS) {
      expect(description).toContain(key);
    }
  });

  test("every angle is named in the synthesis prompt and the finding schema", () => {
    // Synthesis stamps each finding's `angle`; an unlisted key gets rewritten or dropped.
    const synthesis = read("synthesis.md");
    const findingAngle = REVIEW_OUTPUT.shape.blocking.element.shape.angle.description ?? "";
    for (const key of ALL_KEYS) {
      expect(synthesis).toContain(`\`${key}\``);
      expect(findingAngle).toContain(key);
    }
  });

  test("the non-angle finding sources stay documented alongside the angles", () => {
    // adversary/coderabbit/fallow file findings without being selectable angles, so they
    // live only in the prose lists — which is exactly where they rot unnoticed.
    const synthesis = read("synthesis.md");
    const findingAngle = REVIEW_OUTPUT.shape.blocking.element.shape.angle.description ?? "";
    for (const source of ["adversary", "coderabbit", "fallow"]) {
      expect(synthesis).toContain(`\`${source}\``);
      expect(findingAngle).toContain(source);
    }
  });
});
