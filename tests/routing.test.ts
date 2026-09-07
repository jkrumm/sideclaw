// The routing table is the one place a worker's model and auth backend are decided
// (server/lib/routing.ts). These pin the owner's tiering decision and the override rules
// that keep an operator from routing a gateway id onto Max, where it cannot run.

import { describe, expect, test } from "bun:test";
import {
  buildRoutingTable,
  describeRoute,
  GLM_FLASH,
  HAIKU,
  ROUTED_TOOLS,
  routeFor,
  SONNET,
  withModel,
} from "../server/lib/routing.ts";
import { parseDotEnv } from "../server/lib/load-env.ts";

describe("buildRoutingTable defaults", () => {
  const { routes, overrides } = buildRoutingTable({});

  test("no overrides from an empty env", () => {
    expect(overrides).toEqual([]);
  });

  test("check and overview: glm-5.3-flash on iu, Haiku on max as the reverse lane", () => {
    for (const tool of ["check", "overview"] as const) {
      expect(routes[tool]).toEqual({
        model: GLM_FLASH,
        backend: "iu",
        fallback: { backend: "max", model: HAIKU },
      });
    }
  });

  test("narrative: Sonnet on iu, same model on max", () => {
    expect(routes.narrative).toEqual({
      model: SONNET,
      backend: "iu",
      fallback: { backend: "max" },
    });
  });

  test("review, dispatch, otel: Sonnet on max with the quota fallback to iu", () => {
    for (const tool of ["review", "dispatch", "otel"] as const) {
      expect(routes[tool]).toEqual({ model: SONNET, backend: "max", fallback: { backend: "iu" } });
    }
  });

  test("adversary stays gpt-5.6-terra on iu, no fallback", () => {
    expect(routes.adversary).toEqual({ model: "gpt-5.6-terra", backend: "iu", fallback: null });
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

  test("a gateway model override on a max route forces iu and keeps a fixed-model fallback only", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_DISPATCH: "glm-5.3-flash" });
    expect(routes.dispatch.backend).toBe("iu");
    // The backend flip is the override's most consequential side effect (metered IU instead
    // of Max), so /api/routing lists it next to the model override that caused it.
    expect(overrides).toEqual([
      { tool: "dispatch", field: "model", value: "glm-5.3-flash" },
      {
        tool: "dispatch",
        field: "backend",
        value: "iu",
        implied: expect.stringContaining("forced by the glm-5.3-flash model override"),
      },
    ]);
    // dispatch's declared fallback is same-model onto iu; with iu now primary and no fixed
    // Claude fallback model there is nowhere Max-servable to go.
    expect(routes.dispatch.fallback).toBeNull();
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
    const r = withModel(routeFor("dispatch"), "claude-opus-5[1m]");
    expect(r).toEqual({
      model: "claude-opus-5[1m]",
      backend: "max",
      fallback: { backend: "iu" },
    });
  });

  test("a Claude override on check drops the fixed Haiku fallback — same model on max instead", () => {
    const r = withModel(routeFor("overview"), "claude-sonnet-5[1m]");
    expect(r).toEqual({
      model: "claude-sonnet-5[1m]",
      backend: "iu",
      fallback: { backend: "max" },
    });
  });

  test("a gateway override on a max route is forced onto iu with no Max-servable fallback", () => {
    const r = withModel(routeFor("dispatch"), "DeepSeek-V4-Flash");
    expect(r.backend).toBe("iu");
    expect(r.fallback).toBeNull();
  });

  test("a gateway override on check keeps the fixed Haiku fallback", () => {
    const r = withModel(routeFor("check"), "DeepSeek-V4-Flash");
    expect(r).toEqual({
      model: "DeepSeek-V4-Flash",
      backend: "iu",
      fallback: { backend: "max", model: HAIKU },
    });
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
