// The routing table is the one place a worker's model and auth backend are decided
// (server/lib/routing.ts). These pin the owner's tiering decision and the override rules
// that keep an operator from routing a gateway id onto Max, where it cannot run.

import { describe, expect, test } from "bun:test";
import {
  buildRoutingTable,
  describeRoute,
  GLM_FLASH,
  HAIKU,
  logRoutingOverrides,
  logStaleQuotaEnvVars,
  ROUTED_TOOLS,
  routeFor,
  SONNET,
  withModel,
} from "../server/lib/routing.ts";
import { parseDotEnv } from "../server/lib/load-env.ts";

/** Records calls instead of writing anywhere — matches the `{ info, warn }` shape both
 *  functions under test expect. */
function fakeLogger() {
  const info: { obj: Record<string, unknown>; msg: string }[] = [];
  const warn: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    info: (obj: Record<string, unknown>, msg: string) => info.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => warn.push({ obj, msg }),
    calls: { info, warn },
  };
}

describe("buildRoutingTable defaults", () => {
  const { routes, overrides } = buildRoutingTable({});

  test("no overrides from an empty env", () => {
    expect(overrides).toEqual([]);
  });

  test("check, overview, review's router: glm-5.3-flash on iu, Haiku on max as the reverse lane (the CLASSIFY tier)", () => {
    for (const tool of ["check", "overview", "review_router"] as const) {
      expect(routes[tool]).toEqual({
        model: GLM_FLASH,
        backend: "iu",
        fallback: { backend: "max", model: HAIKU },
        transport: "session",
      });
    }
  });

  test("narrative, excalidraw: Sonnet on max, same model on iu as the reverse lane (the PROSE tier)", () => {
    for (const tool of ["narrative", "excalidraw"] as const) {
      expect(routes[tool]).toEqual({
        model: SONNET,
        backend: "max",
        fallback: { backend: "iu" },
        transport: "session",
      });
    }
  });

  test("dispatch: glm-5.3-flash on iu with the Sonnet-on-max quota fallback (the AGENT tier)", () => {
    expect(routes.dispatch).toEqual({
      model: GLM_FLASH,
      backend: "iu",
      fallback: { backend: "max", model: SONNET },
      transport: "session",
    });
  });

  test("review (angles/synthesis/router), otel: Sonnet on max with the quota fallback to iu (the JUDGE tier — deliberately NOT on glm, see routing.ts)", () => {
    for (const tool of ["review", "otel"] as const) {
      expect(routes[tool]).toEqual({
        model: SONNET,
        backend: "max",
        fallback: { backend: "iu" },
        transport: "session",
      });
    }
  });

  test("adversary stays gpt-5.6-terra on iu, no fallback, over the fixed iu-openai transport", () => {
    expect(routes.adversary).toEqual({
      model: "gpt-5.6-terra",
      backend: "iu",
      fallback: null,
      transport: "iu-openai",
    });
  });

  test("read_image, read_drawing: gemini-3.5-flash on iu, no fallback, over the fixed iu-openai transport (the VISION tier)", () => {
    for (const tool of ["read_image", "read_drawing"] as const) {
      expect(routes[tool]).toEqual({
        model: "gemini-3.5-flash",
        backend: "iu",
        fallback: null,
        transport: "iu-openai",
      });
    }
  });

  test("every routed tool has a route and a gateway id never sits on max", () => {
    for (const tool of ROUTED_TOOLS) {
      const r = routes[tool];
      expect(r.model.length).toBeGreaterThan(0);
      if (r.backend === "max") expect(r.model.startsWith("claude")).toBe(true);
      if (r.fallback?.backend === "max") {
        expect((r.fallback.model ?? r.model).startsWith("claude")).toBe(true);
      }
    }
  });
});

describe("buildRoutingTable env overrides", () => {
  test("SIDECLAW_MODEL_<TOOL> replaces the model and is reported", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: HAIKU });
    expect(routes.check.model).toBe(HAIKU);
    expect(routes.check.backend).toBe("iu");
    expect(overrides).toEqual([{ tool: "check", field: "model", value: HAIKU }]);
  });

  test("SIDECLAW_BACKEND_<TOOL> moves a Claude route and flips the fallback direction", () => {
    const { routes } = buildRoutingTable({ SIDECLAW_BACKEND_REVIEW: "iu" });
    expect(routes.review.backend).toBe("iu");
    // The declared fallback pointed at iu — now the primary — so it is dropped, not kept
    // as a no-op hop onto the same backend.
    expect(routes.review.fallback).toBeNull();
  });

  test("a max backend on a gateway id is refused, default stays", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_BACKEND_CHECK: "max" });
    expect(routes.check.backend).toBe("iu");
    expect(overrides[0]?.refused).toContain("max only serves Claude ids");
  });

  test("an unknown backend name is refused", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_BACKEND_OTEL: "bedrock" });
    expect(routes.otel.backend).toBe("max");
    expect(overrides[0]?.refused).toContain("unknown backend");
  });

  test("a backend override on a fixed iu-openai transport tool is refused, whatever the value", () => {
    for (const [envKey, tool] of [
      ["SIDECLAW_BACKEND_ADVERSARY", "adversary"],
      ["SIDECLAW_BACKEND_READ_IMAGE", "read_image"],
      ["SIDECLAW_BACKEND_READ_DRAWING", "read_drawing"],
    ] as const) {
      const { routes, overrides } = buildRoutingTable({ [envKey]: "max" });
      expect(routes[tool].backend).toBe("iu");
      expect(overrides).toEqual([
        {
          tool,
          field: "backend",
          value: "max",
          refused: expect.stringContaining("iu-openai transport"),
        },
      ]);
    }
  });

  test("a gateway model override on a max route forces iu and keeps a fixed-model fallback only", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_REVIEW: "glm-5.3-flash" });
    expect(routes.review.backend).toBe("iu");
    // The backend flip is the override's most consequential side effect (metered IU instead
    // of Max), so /api/routing lists it next to the model override that caused it.
    expect(overrides).toEqual([
      { tool: "review", field: "model", value: "glm-5.3-flash" },
      {
        tool: "review",
        field: "backend",
        value: "iu",
        implied: expect.stringContaining("forced by the glm-5.3-flash model override"),
      },
    ]);
    // review's declared fallback is same-model onto iu; with iu now primary there is
    // nowhere Max-servable to go.
    expect(routes.review.fallback).toBeNull();
    const narrative = buildRoutingTable({ SIDECLAW_MODEL_NARRATIVE: "glm-5.3-flash" }).routes
      .narrative;
    expect(narrative.fallback).toBeNull();
  });

  test("whitespace-only overrides are ignored", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: "  " });
    expect(routes.check.model).toBe(GLM_FLASH);
    expect(overrides).toEqual([]);
  });
});

describe("withModel", () => {
  test("no override returns the route unchanged", () => {
    const r = routeFor("dispatch");
    expect(withModel(r, undefined)).toBe(r);
    expect(withModel(r, r.model)).toBe(r);
  });

  test("a Claude override on a max route keeps max and the iu fallback", () => {
    const r = withModel(routeFor("review"), "claude-opus-5[1m]");
    expect(r).toEqual({
      model: "claude-opus-5[1m]",
      backend: "max",
      fallback: { backend: "iu" },
      transport: "session",
    });
  });

  test("a Claude override on check drops the fixed Haiku fallback — same model on max instead", () => {
    const r = withModel(routeFor("overview"), "claude-sonnet-5[1m]");
    expect(r).toEqual({
      model: "claude-sonnet-5[1m]",
      backend: "iu",
      fallback: { backend: "max" },
      transport: "session",
    });
  });

  test("a gateway override on a max route is forced onto iu with no Max-servable fallback", () => {
    const r = withModel(routeFor("review"), "DeepSeek-V4-Flash");
    expect(r.backend).toBe("iu");
    expect(r.fallback).toBeNull();
  });

  test("a gateway override on check keeps the fixed Haiku fallback", () => {
    const r = withModel(routeFor("check"), "DeepSeek-V4-Flash");
    expect(r).toEqual({
      model: "DeepSeek-V4-Flash",
      backend: "iu",
      fallback: { backend: "max", model: HAIKU },
      transport: "session",
    });
  });

  test("transport is preserved across a model override", () => {
    const r = withModel(routeFor("adversary"), "gpt-6-terra");
    expect(r.transport).toBe("iu-openai");
  });
});

describe("routeFor / describeRoute", () => {
  test("routeFor hands out a copy — mutating it cannot poison the table", () => {
    const a = routeFor("check");
    a.model = "mutated";
    if (a.fallback) a.fallback.model = "mutated";
    expect(routeFor("check").model).toBe(GLM_FLASH);
    expect(routeFor("check").fallback?.model).toBe(HAIKU);
  });

  test("describeRoute renders the fallback model or the primary when none is fixed", () => {
    expect(describeRoute(routeFor("check"))).toBe(`${GLM_FLASH} on iu (fallback ${HAIKU} on max)`);
    expect(describeRoute(routeFor("review"))).toBe(`${SONNET} on max (fallback ${SONNET} on iu)`);
    expect(describeRoute(routeFor("adversary"))).toBe("gpt-5.6-terra on iu");
  });
});

describe("parseDotEnv (the MCP process's .env loader)", () => {
  test("parses KEY=value, quotes, comments and blank lines the way the real file uses them", () => {
    const text = [
      "# comment",
      "",
      "PLAIN=abc",
      'DQ="with spaces"',
      "SQ='single'",
      "TRAIL=value # trailing comment",
      "export EXPORTED=1",
      "EMPTY=",
      "not a pair",
      "=nokey",
    ].join("\n");
    expect(parseDotEnv(text)).toEqual({
      PLAIN: "abc",
      DQ: "with spaces",
      SQ: "single",
      TRAIL: "value",
      EXPORTED: "1",
      EMPTY: "",
    });
  });
});

describe("logRoutingOverrides", () => {
  test("no overrides at all → logs nothing", () => {
    const log = fakeLogger();
    logRoutingOverrides(log, []);
    expect(log.calls.info).toEqual([]);
    expect(log.calls.warn).toEqual([]);
  });

  test("an applied-only override list logs info, not warn", () => {
    const log = fakeLogger();
    const overrides = [{ tool: "check", field: "model", value: HAIKU } as const];
    logRoutingOverrides(log, overrides);
    expect(log.calls.warn).toEqual([]);
    expect(log.calls.info).toEqual([
      {
        obj: { event: "routing.overrides", overrides },
        msg: "routing overrides applied at startup",
      },
    ]);
  });

  test("any refused override in the list logs warn, even alongside applied ones", () => {
    const log = fakeLogger();
    const overrides = [
      { tool: "check", field: "model", value: HAIKU } as const,
      {
        tool: "otel",
        field: "backend",
        value: "bedrock",
        refused: 'unknown backend — expected "iu" or "max"',
      } as const,
    ];
    logRoutingOverrides(log, overrides);
    expect(log.calls.info).toEqual([]);
    expect(log.calls.warn).toEqual([
      {
        obj: { event: "routing.overrides", overrides },
        msg: "routing overrides applied at startup (one or more refused)",
      },
    ]);
  });
});

describe("logStaleQuotaEnvVars", () => {
  test("none of the three set → logs nothing", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, {});
    expect(log.calls.warn).toEqual([]);
  });

  test("unrelated env vars set → still logs nothing", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, { SIDECLAW_MODEL_CHECK: HAIKU, GITHUB_TOKEN: "x" });
    expect(log.calls.warn).toEqual([]);
  });

  test("one stale var set → warns once, naming only what's set", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, { SIDECLAW_MAX_QUOTA_CEILING: "90" });
    expect(log.calls.warn).toHaveLength(1);
    expect(log.calls.warn[0]?.obj).toEqual({
      event: "routing.stale_env",
      vars: ["SIDECLAW_MAX_QUOTA_CEILING"],
    });
  });

  test("all three stale vars set → one warn listing all three", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, {
      SIDECLAW_MAX_QUOTA_CEILING: "90",
      SIDECLAW_MAX_WEEKLY_CEILING: "95",
      SIDECLAW_QUOTA_FILE_MAX_AGE_S: "600",
    });
    expect(log.calls.warn).toHaveLength(1);
    expect(log.calls.warn[0]?.obj.vars).toEqual([
      "SIDECLAW_MAX_QUOTA_CEILING",
      "SIDECLAW_MAX_WEEKLY_CEILING",
      "SIDECLAW_QUOTA_FILE_MAX_AGE_S",
    ]);
  });
});
