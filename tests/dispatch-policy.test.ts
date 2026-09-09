// The dispatch repo policy (server/lib/dispatch-policy.ts) is the boundary that closes the
// bypass described in the module's own header: POST /api/jobs had no repo allowlist and no
// tier ceiling, and `sensitive` was a caller-declared field sideclaw never verified. These
// pin the default rule table, the "env can only narrow, never widen" override contract, and
// that resolveDispatchTarget never throws.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test, afterAll } from "bun:test";
import {
  buildDispatchPolicy,
  DEFAULT_RULE,
  logDispatchPolicy,
  resolveDispatchTarget,
  type DispatchPolicy,
} from "../server/lib/dispatch-policy.ts";
import { WORKSPACE_ROOTS } from "../server/lib/workspace.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";
import { dispatchPolicyRoutes } from "../server/routes/dispatch-policy.ts";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";

/** Records calls instead of writing anywhere — matches the `{ info, warn }` shape both
 *  functions under test expect (same helper shape as tests/routing.test.ts). */
function fakeLogger() {
  const info: { obj: Record<string, unknown>; msg: string }[] = [];
  const warn: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    info: (obj: Record<string, unknown>, msg: string) => info.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => warn.push({ obj, msg }),
    calls: { info, warn },
  };
}

const ROOT = WORKSPACE_ROOTS[0];
const DEFAULT_POLICY: DispatchPolicy = buildDispatchPolicy({});

describe("buildDispatchPolicy defaults", () => {
  test("no overrides from an empty env", () => {
    expect(DEFAULT_POLICY.overrides).toEqual([]);
  });

  test("roots default to WORKSPACE_ROOTS", () => {
    expect(DEFAULT_POLICY.roots).toEqual(WORKSPACE_ROOTS);
  });

  test("an unruled repo gets the permissive default rule", () => {
    expect(DEFAULT_POLICY.rules["some-repo-with-no-rule"]).toBeUndefined();
    expect(DEFAULT_RULE).toEqual({ ceiling: "implement", sensitive: false });
  });
});

describe("resolveDispatchTarget — accepts within ceiling", () => {
  test("an unruled repo at implement (the permissive default)", () => {
    const r = resolveDispatchTarget({ cwd: join(ROOT, "vps"), tier: "implement" }, DEFAULT_POLICY);
    expect(r).toEqual({ ok: true, repo: "vps", root: ROOT, sensitive: false });
  });

  test("hermes-agent at investigate (its own ceiling)", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "hermes-agent"), tier: "investigate" },
      DEFAULT_POLICY,
    );
    expect(r).toEqual({ ok: true, repo: "hermes-agent", root: ROOT, sensitive: false });
  });

  test("sideclaw / warden at investigate — the one tier their pinned ceiling allows", () => {
    for (const repo of ["sideclaw", "warden"]) {
      const r = resolveDispatchTarget(
        { cwd: join(ROOT, repo), tier: "investigate" },
        DEFAULT_POLICY,
      );
      expect(r).toEqual({ ok: true, repo, root: ROOT, sensitive: false });
    }
  });

  test("dotfiles-private at investigate returns sensitive: true", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "dotfiles-private"), tier: "investigate" },
      DEFAULT_POLICY,
    );
    expect(r).toEqual({ ok: true, repo: "dotfiles-private", root: ROOT, sensitive: true });
  });
});

describe("resolveDispatchTarget — refuses on ceiling", () => {
  test("hermes-agent at implement", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "hermes-agent"), tier: "implement" },
      DEFAULT_POLICY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exceeds the ceiling 'investigate'");
  });

  test("dotfiles at author", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "dotfiles"), tier: "author" },
      DEFAULT_POLICY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("dotfiles");
  });

  test("brain at implement", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "brain"), tier: "implement" },
      DEFAULT_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  test("dotfiles-private at author and at implement", () => {
    for (const tier of ["author", "implement"] as const) {
      const r = resolveDispatchTarget(
        { cwd: join(ROOT, "dotfiles-private"), tier },
        DEFAULT_POLICY,
      );
      expect(r.ok).toBe(false);
    }
  });

  test("homelab-private at implement is refused — sensitive is never mentioned by the caller, closing the exact bypass this module fixes", () => {
    // resolveDispatchTarget takes only { cwd, tier } — there is no way for a caller to
    // declare `sensitive` here at all, and the repo is refused purely on the policy's own
    // ceiling. Before this module existed, omitting `sensitive: true` on the job params was
    // enough to reach `implement` inside this exact repo.
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "homelab-private"), tier: "implement" },
      DEFAULT_POLICY,
    );
    expect(r).toEqual({
      ok: false,
      reason: "tier 'implement' exceeds the ceiling 'investigate' for repo 'homelab-private'",
    });
  });

  test("sideclaw at implement and at author", () => {
    for (const tier of ["implement", "author"] as const) {
      const r = resolveDispatchTarget({ cwd: join(ROOT, "sideclaw"), tier }, DEFAULT_POLICY);
      expect(r.ok).toBe(false);
    }
  });

  test("warden at implement and at author", () => {
    for (const tier of ["implement", "author"] as const) {
      const r = resolveDispatchTarget({ cwd: join(ROOT, "warden"), tier }, DEFAULT_POLICY);
      expect(r.ok).toBe(false);
    }
  });
});

describe("resolveDispatchTarget — path shape", () => {
  test("a path outside every configured root", () => {
    const r = resolveDispatchTarget(
      { cwd: join(tmpdir(), "not-a-dispatch-root"), tier: "investigate" },
      DEFAULT_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  test("a root itself, not a repo under it", () => {
    const r = resolveDispatchTarget({ cwd: ROOT, tier: "investigate" }, DEFAULT_POLICY);
    expect(r.ok).toBe(false);
  });

  test("a nested subdirectory of a repo, not the repo itself", () => {
    const r = resolveDispatchTarget(
      { cwd: join(ROOT, "vps", "observability"), tier: "investigate" },
      DEFAULT_POLICY,
    );
    expect(r.ok).toBe(false);
  });

  test("an unknown tier string fails closed", () => {
    const r = resolveDispatchTarget({ cwd: join(ROOT, "vps"), tier: "yolo" }, DEFAULT_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("yolo");
  });
});

describe("resolveDispatchTarget — never throws", () => {
  test("an empty cwd", () => {
    expect(() =>
      resolveDispatchTarget({ cwd: "", tier: "investigate" }, DEFAULT_POLICY),
    ).not.toThrow();
    expect(resolveDispatchTarget({ cwd: "", tier: "investigate" }, DEFAULT_POLICY)).toEqual({
      ok: false,
      reason: "cwd is required",
    });
  });

  test("a path containing ..", () => {
    expect(() =>
      resolveDispatchTarget(
        { cwd: join(ROOT, "..", "..", "etc"), tier: "investigate" },
        DEFAULT_POLICY,
      ),
    ).not.toThrow();
  });

  test("a path that does not exist on disk", () => {
    expect(() =>
      resolveDispatchTarget(
        { cwd: join(ROOT, "definitely-does-not-exist-xyz"), tier: "investigate" },
        DEFAULT_POLICY,
      ),
    ).not.toThrow();
  });
});

describe("resolveDispatchTarget — symlink resolution", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dispatch-policy-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "dispatch-policy-outside-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  // realpath'd up front: macOS resolves TMPDIR through /var -> /private/var, and
  // resolveDispatchTarget canonicalizes an existing cwd via realpathSync (that is the whole
  // point under test) while roots are only resolve()'d — so an un-canonicalized root here
  // would never match, for a reason that has nothing to do with the behavior being tested.
  const rootPath = join(scratch, "root");
  mkdirSync(rootPath, { recursive: true });
  const root = realpathSync(rootPath);
  const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_ROOTS: root });

  test("the resolved repo name comes from the realpath, not the symlink name", () => {
    const realRepo = join(root, "real-repo");
    mkdirSync(realRepo);
    const linkRepo = join(root, "link-repo");
    symlinkSync(realRepo, linkRepo);

    const r = resolveDispatchTarget({ cwd: linkRepo, tier: "implement" }, policy);
    expect(r).toEqual({ ok: true, repo: "real-repo", root, sensitive: false });
  });

  test("a symlink pointing outside every root is refused, not silently followed in", () => {
    const linkOutside = join(root, "link-outside");
    symlinkSync(outside, linkOutside);

    const r = resolveDispatchTarget({ cwd: linkOutside, tier: "investigate" }, policy);
    expect(r.ok).toBe(false);
  });
});

describe("buildDispatchPolicy env overrides — ceilings", () => {
  test("lowering a ceiling is applied", () => {
    const { rules, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_CEILINGS: "vps:investigate",
    });
    expect(rules.vps).toEqual({ ceiling: "investigate", sensitive: false });
    expect(overrides).toEqual([
      { key: "SIDECLAW_DISPATCH_CEILINGS", value: "vps:investigate", applied: true },
    ]);
  });

  test("raising a ceiling is refused with a reason, default stays", () => {
    const { rules, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_CEILINGS: "dotfiles:implement",
    });
    expect(rules.dotfiles).toEqual({ ceiling: "investigate", sensitive: false });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.applied).toBe(false);
    expect(overrides[0]?.reason).toContain("does not lower");
  });

  test("naming sideclaw is refused, whatever the value", () => {
    const { rules, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_CEILINGS: "sideclaw:investigate",
    });
    expect(rules.sideclaw).toEqual({ ceiling: "investigate", sensitive: false });
    expect(overrides[0]?.applied).toBe(false);
    expect(overrides[0]?.reason).toContain("pinned");
  });

  test("naming warden is refused, whatever the value", () => {
    const { rules, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_CEILINGS: "warden:author",
    });
    expect(rules.warden).toEqual({ ceiling: "investigate", sensitive: false });
    expect(overrides[0]?.applied).toBe(false);
    expect(overrides[0]?.reason).toContain("pinned");
  });

  test("an unknown tier in the ceiling string is refused", () => {
    const { rules, overrides } = buildDispatchPolicy({ SIDECLAW_DISPATCH_CEILINGS: "vps:bogus" });
    expect(rules.vps).toBeUndefined();
    expect(overrides[0]?.applied).toBe(false);
    expect(overrides[0]?.reason).toContain("unknown tier");
  });
});

describe("buildDispatchPolicy env overrides — sensitive", () => {
  test("adding sensitive is applied, and clamps the ceiling with it", () => {
    // The ceiling moves too — `sensitive` means "investigate only" everywhere else in this
    // estate, and leaving the two independent let an `implement` submission reach a job row
    // before assertSensitiveTierAllowed refused it. Stricter than the original expectation.
    const { rules, overrides } = buildDispatchPolicy({ SIDECLAW_DISPATCH_SENSITIVE: "vps" });
    expect(rules.vps).toEqual({ ceiling: "investigate", sensitive: true });
    expect(overrides).toEqual([
      { key: "SIDECLAW_DISPATCH_SENSITIVE", value: "vps", applied: true },
    ]);
  });

  test("an already-sensitive repo is a no-op recorded as applied", () => {
    const { rules, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_SENSITIVE: "dotfiles-private",
    });
    expect(rules["dotfiles-private"]).toEqual({ ceiling: "investigate", sensitive: true });
    expect(overrides).toEqual([
      { key: "SIDECLAW_DISPATCH_SENSITIVE", value: "dotfiles-private", applied: true },
    ]);
  });

  test("naming a pinned repo is refused — the pinned merge would silently discard it anyway", () => {
    const { rules, overrides } = buildDispatchPolicy({ SIDECLAW_DISPATCH_SENSITIVE: "sideclaw" });
    expect(rules.sideclaw).toEqual({ ceiling: "investigate", sensitive: false });
    expect(overrides[0]?.applied).toBe(false);
    expect(overrides[0]?.reason).toContain("pinned");
  });
});

describe("buildDispatchPolicy env overrides — roots", () => {
  test("a relative path is refused while absolute siblings still apply", () => {
    const { roots, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_ROOTS: "relative/path,/abs/one,/abs/two",
    });
    expect(roots).toEqual(["/abs/one", "/abs/two"]);
    expect(overrides).toEqual([
      {
        key: "SIDECLAW_DISPATCH_ROOTS",
        value: "relative/path",
        applied: false,
        reason: "not an absolute path: relative/path",
      },
      { key: "SIDECLAW_DISPATCH_ROOTS", value: "/abs/one", applied: true },
      { key: "SIDECLAW_DISPATCH_ROOTS", value: "/abs/two", applied: true },
    ]);
  });

  test("every entry relative falls back to the default roots", () => {
    const { roots, overrides } = buildDispatchPolicy({
      SIDECLAW_DISPATCH_ROOTS: "relative/one,relative/two",
    });
    expect(roots).toEqual(WORKSPACE_ROOTS);
    expect(overrides.some((o) => !o.applied)).toBe(true);
  });
});

describe("logDispatchPolicy", () => {
  test("no overrides at all → logs nothing", () => {
    const log = fakeLogger();
    logDispatchPolicy(log, []);
    expect(log.calls.info).toEqual([]);
    expect(log.calls.warn).toEqual([]);
  });

  test("one record per applied override on info, one per refused override on warn", () => {
    const log = fakeLogger();
    const overrides = [
      { key: "SIDECLAW_DISPATCH_CEILINGS", value: "vps:investigate", applied: true },
      {
        key: "SIDECLAW_DISPATCH_CEILINGS",
        value: "dotfiles:implement",
        applied: false,
        reason: "does not lower dotfiles's ceiling",
      },
      { key: "SIDECLAW_DISPATCH_SENSITIVE", value: "vps", applied: true },
    ];
    logDispatchPolicy(log, overrides);
    expect(log.calls.info).toHaveLength(2);
    expect(log.calls.warn).toHaveLength(1);
    expect(log.calls.warn[0]?.obj.reason).toBe("does not lower dotfiles's ceiling");
  });
});

// ── Regression pins from the 2026-09-09 review ────────────────────────────────────────────
// Three fail-OPEN paths, none of them reachable on the tree as it stands, all of them the
// kind that stay invisible until the day DEFAULT_RULE stops being permissive.

describe("the rule lookup cannot be missed by spelling", () => {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "sideclaw-policy-case-")));
  // A repo whose on-disk name is lowercase (the real shape — every ruled repo on this box is
  // lowercase, verified) and one whose on-disk name carries capitals (the shape that would
  // silently stop matching a lowercase rule key).
  mkdirSync(join(tmpRoot, "homelab-private"));
  mkdirSync(join(tmpRoot, "Dotfiles-Private"));
  const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_ROOTS: tmpRoot });

  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("a case-flipped cwd still lands on the lowercase rule, not on DEFAULT_RULE", () => {
    // APFS is case-insensitive, so this path IS the homelab-private directory. `realpathSync`
    // returns the on-disk spelling, so this would pass even without the lowercasing — the
    // point of the test is that it must keep passing if that ever changes.
    for (const spelling of ["homelab-private", "Homelab-Private", "HOMELAB-PRIVATE"]) {
      const r = resolveDispatchTarget({ cwd: join(tmpRoot, spelling), tier: "implement" }, policy);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("exceeds the ceiling 'investigate'");
    }
  });

  test("a repo whose DIRECTORY carries capitals still matches its lowercase rule key", () => {
    // This is the case the lowercasing genuinely buys: the on-disk name is `Dotfiles-Private`,
    // so `basename(realpathSync(...))` returns exactly that, and a plain `rules[repo]` lookup
    // would miss the `dotfiles-private` key and fall through to DEFAULT_RULE — `implement`,
    // in a secret-bearing repo, with `sensitive` false.
    const r = resolveDispatchTarget(
      { cwd: join(tmpRoot, "Dotfiles-Private"), tier: "implement" },
      policy,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exceeds the ceiling 'investigate'");
  });

  test("and it is still marked sensitive at the tier it IS allowed", () => {
    const r = resolveDispatchTarget(
      { cwd: join(tmpRoot, "Dotfiles-Private"), tier: "investigate" },
      policy,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sensitive).toBe(true);
  });
});

describe("a repo named after a prototype property is not a rule", () => {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "sideclaw-policy-proto-")));
  for (const name of ["constructor", "toString", "hasOwnProperty"]) mkdirSync(join(tmpRoot, name));
  const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_ROOTS: tmpRoot });

  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("resolves to DEFAULT_RULE rather than an inherited Object.prototype value", () => {
    // With `rules[repo] ?? DEFAULT_RULE` these returned a function off the prototype, so `??`
    // never fired, `rule.ceiling` read undefined, `tierRank(undefined)` was 99, and
    // `tierRank('implement') > 99` was FALSE — i.e. admitted, with `sensitive` undefined.
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const r = resolveDispatchTarget({ cwd: join(tmpRoot, name), tier: "implement" }, policy);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.repo).toBe(name);
        expect(r.sensitive).toBe(DEFAULT_RULE.sensitive);
      }
    }
  });

  test("and __proto__ as a ceiling override name cannot poison the table", () => {
    const poisoned = buildDispatchPolicy({
      SIDECLAW_DISPATCH_ROOTS: tmpRoot,
      SIDECLAW_DISPATCH_CEILINGS: "__proto__:investigate",
    });
    // Whatever that entry did to its own table, an UNRELATED repo must still read DEFAULT_RULE.
    const r = resolveDispatchTarget(
      { cwd: join(tmpRoot, "constructor"), tier: "implement" },
      poisoned,
    );
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).ceiling).toBeUndefined();
  });
});

describe("an env override is normalized, not taken literally", () => {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "sideclaw-policy-envcase-")));
  mkdirSync(join(tmpRoot, "some-repo"));
  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("a ceiling override spelled in mixed case still binds to the repo", () => {
    const policy = buildDispatchPolicy({
      SIDECLAW_DISPATCH_ROOTS: tmpRoot,
      SIDECLAW_DISPATCH_CEILINGS: "Some-Repo:investigate",
    });
    expect(policy.overrides.find((o) => o.value === "Some-Repo:investigate")?.applied).toBe(true);
    const r = resolveDispatchTarget({ cwd: join(tmpRoot, "some-repo"), tier: "author" }, policy);
    expect(r.ok).toBe(false);
  });

  test("a pinned repo named in mixed case is still refused", () => {
    const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_CEILINGS: "SideClaw:implement" });
    const o = policy.overrides.find((x) => x.value === "SideClaw:implement");
    expect(o?.applied).toBe(false);
    expect(o?.reason).toContain("pinned");
    expect(policy.rules.sideclaw).toEqual({ ceiling: "investigate", sensitive: false });
  });
});

describe("an override named after a prototype key cannot reshape the table", () => {
  // The write side of the same problem `lookupRule` guards on the read side. On a plain
  // object literal `rules["__proto__"] = x` runs the inherited setter and REASSIGNS the
  // object's prototype instead of creating an own property — the entry silently vanishes
  // while being reported `applied: true`. The table is built with `Object.create(null)`, so
  // the key is now an ordinary own property with no setter to trigger.
  for (const evil of ["__proto__", "constructor", "prototype"]) {
    test(`'${evil}' as a ceiling override is an ordinary key, not a prototype write`, () => {
      const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_CEILINGS: `${evil}:investigate` });
      const o = policy.overrides.find((x) => x.value === `${evil}:investigate`);
      // It is reported applied, and it must actually BE applied — reported-but-vanished is
      // the exact failure this pins.
      expect(o?.applied).toBe(true);
      expect(Object.hasOwn(policy.rules, evil)).toBe(true);
      expect(policy.rules[evil]).toEqual({ ceiling: "investigate", sensitive: false });
      // And nothing leaked onto Object.prototype for everyone else.
      expect(({} as Record<string, unknown>).ceiling).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    test(`'${evil}' as a sensitive override is an ordinary key too`, () => {
      const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_SENSITIVE: evil });
      expect(policy.overrides.find((x) => x.value === evil)?.applied).toBe(true);
      expect(Object.hasOwn(policy.rules, evil)).toBe(true);
      expect(policy.rules[evil]?.sensitive).toBe(true);
      expect(({} as Record<string, unknown>).sensitive).toBeUndefined();
    });
  }

  test("the pinned entries survive every one of those writes", () => {
    const policy = buildDispatchPolicy({
      SIDECLAW_DISPATCH_CEILINGS: "__proto__:investigate",
      SIDECLAW_DISPATCH_SENSITIVE: "constructor",
    });
    expect(policy.rules.sideclaw).toEqual({ ceiling: "investigate", sensitive: false });
    expect(policy.rules.warden).toEqual({ ceiling: "investigate", sensitive: false });
  });
});

describe("marking a repo sensitive clamps its ceiling", () => {
  test("a policy-neutral repo marked sensitive drops to investigate", () => {
    // Otherwise the route's ceiling-only pre-check admits an `implement` submission, spends a
    // job row and a queue slot, and the refusal only lands later inside runDispatch.
    const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_SENSITIVE: "some-repo" });
    expect(policy.rules["some-repo"]).toEqual({ ceiling: "investigate", sensitive: true });
  });

  test("a repo already at investigate is unchanged apart from the flag", () => {
    const policy = buildDispatchPolicy({ SIDECLAW_DISPATCH_SENSITIVE: "brain" });
    expect(policy.rules.brain).toEqual({ ceiling: "investigate", sensitive: true });
  });
});

describe("POST /api/jobs refuses at submit, before a job row exists", () => {
  // The fallthrough case below deliberately DOES create a row, and the store is one sqlite
  // file shared across the whole `bun test` run (tests/setup.ts) — several suites assert on an
  // empty store. Same cleanup contract tests/execute-drain-abandon.test.ts already uses.
  afterAll(() => __resetForTests());

  test("a dispatch outside every root is a 400 and creates nothing", async () => {
    const before = listJobs().length;
    const res = await jobsRoutes.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "dispatch",
          params: { cwd: "/tmp/definitely-not-a-dispatch-root", tier: "investigate", brief: "x" },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("dispatch refused");
    expect(listJobs().length).toBe(before);
  });

  test("a tier above a pinned repo's ceiling is a 400 and creates nothing", async () => {
    // Against the SINGLETON policy, whose roots are the temp root tests/setup.ts seeds — so
    // the pinned repo has to exist under THAT root, not under the real ~/SourceRoot, or this
    // would refuse for being outside every root and never reach the ceiling check at all.
    const testRoot = (process.env.SIDECLAW_DISPATCH_ROOTS ?? "").split(",")[0]?.trim() ?? "";
    expect(testRoot).not.toBe("");
    const pinned = join(testRoot, "sideclaw");
    mkdirSync(pinned, { recursive: true });
    const before = listJobs().length;
    const res = await jobsRoutes.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "dispatch",
          params: { cwd: pinned, tier: "implement", brief: "x" },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("exceeds the ceiling 'investigate'");
    expect(listJobs().length).toBe(before);
    rmSync(pinned, { recursive: true, force: true });
  });

  test("a non-string cwd falls through to the handler's own validation, unrefused here", async () => {
    // Deliberate: the route only engages when it can positively determine a violation. A
    // malformed `cwd` is zod's error to report at execution, and reshaping that error is not
    // this gate's job — but the fallthrough must be a real, tested path, not an accident.
    const res = await jobsRoutes.handle(
      new Request("http://localhost/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "dispatch", params: { cwd: 42, tier: "implement" } }),
      }),
    );
    expect(res.status).not.toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("GET /api/dispatch-policy", () => {
  test("returns the effective table in the documented shape", async () => {
    const res = await dispatchPolicyRoutes.handle(
      new Request("http://localhost/api/dispatch-policy"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      roots: string[];
      rules: Record<string, { ceiling: string; sensitive: boolean }>;
      overrides: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.roots)).toBe(true);
    expect(Array.isArray(body.overrides)).toBe(true);
    // The two pins are the whole reason a reader checks this endpoint.
    expect(body.rules.sideclaw).toEqual({ ceiling: "investigate", sensitive: false });
    expect(body.rules.warden).toEqual({ ceiling: "investigate", sensitive: false });
  });
});
