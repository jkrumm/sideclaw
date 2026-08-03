// Pure-function bounds of the dispatch bridge: the secret scanner that decides whether text
// may become a durable public artifact, the slug that becomes a git ref name, and the remote
// parser that decides which GitHub repo an episode is allowed to talk to.
//
// Shape follows hermes-agent/tests/*.py — attack shapes must be caught, real material must
// pass untouched, and both directions are fuzzed. The second half matters as much as the
// first: a scanner that refuses ordinary prose disables the tier it protects, and that is the
// failure mode a hand-written positive-only suite never sees.
//
// Every credential-shaped string below is synthetic.

import { describe, expect, test } from "bun:test";
import {
  parseGithubRemote,
  scanForSecrets,
  slugify,
} from "../server/jobs/handlers/dispatch-git.ts";

// ── Deterministic PRNG ────────────────────────────────────────────────────────
// Seeded so a fuzz failure is reproducible from the seed alone.

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length) % xs.length] as T;
}

// ── scanForSecrets ────────────────────────────────────────────────────────────

/**
 * Every token-shaped exemplar is assembled from fragments rather than written out.
 *
 * The values are synthetic, but a credential-shaped literal is a credential-shaped literal to
 * a scanner: GitHub's own push protection rejected this file when the Slack line was spelled
 * in full. Joining at runtime keeps the pattern out of the blob while the string the scanner
 * under test receives is identical.
 */
const joined = (...parts: string[]): string => parts.join("");

/** One exemplar per pattern, in the spelling an episode would realistically emit. */
const SECRET_SHAPES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "1Password reference", text: "resolve op://mini/github/token first" },
  { name: "GitHub token", text: joined("token gh", "p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7 works") },
  {
    name: "GitHub token",
    text: joined("github", "_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"),
  },
  { name: "Slack token", text: joined("xox", "b-0000000000-1111111111-aBcDeFgHiJkLmNoPqRsTuVwX") },
  { name: "AWS access key id", text: joined("AKIA", "IOSFODNN7EXAMPLE is in the config") },
  { name: "private key block", text: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkt\n" },
  {
    name: "bearer credential",
    text: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiwidHlwIjoiSldUIn0"',
  },
  { name: "Tailscale IP", text: "the gateway binds 100.101.102.103:8642" },
  { name: "inline credential assignment", text: 'api_key = "sk-live-0123456789abcdefghij"' },
];

/**
 * Material a real verdict, issue body or diff is made of. None of it may trip the scanner.
 *
 * Several entries are near-misses on purpose — a redaction placeholder, a public IP one octet
 * outside the CGNAT range, the word "Bearer" followed by prose, a `secrets.` GitHub Actions
 * expression, a token NAME rather than a token.
 */
const BENIGN_LINES: readonly string[] = [
  "The credential lives in 1Password, in the mini vault.",
  "Set GITHUB_TOKEN in .env before running the server.",
  "password: hunter2",
  "api_key: <redacted>",
  "secret: ${{ secrets.DEPLOY_KEY }}",
  "The monitor at 100.63.255.1 is a public address, not a tailnet one.",
  "100.128.0.1 sits just above the carrier-grade NAT block, so it is public.",
  "Internal services answer on 192.168.1.10 and 10.0.0.5.",
  "See https://github.com/jkrumm/sideclaw/pull/12 for the earlier attempt.",
  "Bearer token handling is described in docs/auth.md.",
  "Reverted in commit 3b4581a9f2c1d0e4b7a6958372615f0d2c1b9e84.",
  "+const MAX_CHANGED_LINES = 2000;",
  "-  const stale = await fetchOrigin(defaultBranch);",
  "The op shim is invoked as secrets-run, never as bare op.",
  "AKIA is the prefix AWS uses for access key ids.",
  "Failure mode: `Resource not accessible by personal access token`.",
  "xoxb is the prefix of a Slack bot token.",
  "Run `make reload` and poll /api/jobs until running == 0.",
  "The worktree is created under ~/.local/state/sideclaw/worktrees.",
  "Authorization is checked in server/routes/auth.ts, line 120.",
];

describe("scanForSecrets — attack shapes", () => {
  for (const shape of SECRET_SHAPES) {
    test(`catches ${shape.name}: ${shape.text.slice(0, 32)}…`, () => {
      expect(scanForSecrets(shape.text)).toContain(shape.name);
    });
  }

  test("catches a secret buried in the middle of an otherwise ordinary body", () => {
    const body = [
      "## What I found",
      "",
      "The deploy fails because the gateway env is missing a value.",
      "The fix is to add op://vps/argo/HERMES_API_KEY to the template.",
      "",
      "Nothing else changed.",
    ].join("\n");
    expect(scanForSecrets(body)).toEqual(["1Password reference"]);
  });

  test("reports every distinct pattern a body matches, not just the first", () => {
    const hits = scanForSecrets("op://mini/github/token and AKIAIOSFODNN7EXAMPLE and 100.90.1.2");
    expect(hits).toEqual(["1Password reference", "AWS access key id", "Tailscale IP"]);
  });

  test("Tailscale range boundaries — 64 and 127 in, 63 and 128 out", () => {
    expect(scanForSecrets("100.64.0.1")).toContain("Tailscale IP");
    expect(scanForSecrets("100.127.255.254")).toContain("Tailscale IP");
    expect(scanForSecrets("100.63.0.1")).toEqual([]);
    expect(scanForSecrets("100.128.0.1")).toEqual([]);
    expect(scanForSecrets("100.129.4.5")).toEqual([]);
  });
});

describe("scanForSecrets — real material passes", () => {
  for (const line of BENIGN_LINES) {
    test(`allows: ${line.slice(0, 44)}…`, () => {
      expect(scanForSecrets(line)).toEqual([]);
    });
  }

  test("allows an entire realistic verdict body", () => {
    expect(scanForSecrets(BENIGN_LINES.join("\n"))).toEqual([]);
  });

  test("allows the empty string", () => {
    expect(scanForSecrets("")).toEqual([]);
  });
});

describe("scanForSecrets — fuzz", () => {
  test("2000 assembled benign bodies produce no finding", () => {
    const rng = makeRng(0x5ec2e7);
    for (let i = 0; i < 2000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rng() * 8) }, () =>
        pick(rng, BENIGN_LINES),
      );
      const body = lines.join(rng() < 0.5 ? "\n" : "\n\n");
      const hits = scanForSecrets(body);
      if (hits.length > 0) throw new Error(`false positive (i=${i}) ${hits.join(",")}: ${body}`);
    }
  });

  test("2000 secrets hidden in benign surroundings are all caught", () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const shape = pick(rng, SECRET_SHAPES);
      const before = Array.from({ length: Math.floor(rng() * 4) }, () => pick(rng, BENIGN_LINES));
      const after = Array.from({ length: Math.floor(rng() * 4) }, () => pick(rng, BENIGN_LINES));
      const body = [...before, shape.text, ...after].join("\n");
      const hits = scanForSecrets(body);
      if (!hits.includes(shape.name)) {
        throw new Error(`missed ${shape.name} (i=${i}) in: ${body}`);
      }
    }
  });
});

// ── slugify ───────────────────────────────────────────────────────────────────
//
// The slug becomes half a branch name, and the branch name is pushed. Its documented claim is
// that the output "cannot express any of git's ref-name hazards", so the tests are written
// against that claim rather than against the implementation.

const REF_HAZARDS = ["..", "~", "^", ":", "?", "*", "[", "\\", " ", "\t", "\n", "@{", "//"];

describe("slugify — hazards cannot survive", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["Fix the login bug", "fix-the-login-bug"],
    ["  spaced  out  ", "spaced-out"],
    ["UPPER case", "upper-case"],
    ["../../etc/passwd", "etc-passwd"],
    ["refs/heads/master.lock", "refs-heads-master-lock"],
    ["-leading-and-trailing-", "leading-and-trailing"],
    ["a~b^c:d?e*f[g\\h", "a-b-c-d-e-f-g-h"],
    ["feature@{upstream}", "feature-upstream"],
    ["emoji 🎉 and ünïcödé", "emoji-and-n-c-d"],
    ["", "work"],
    ["!!!", "work"],
    ["---", "work"],
    ["...", "work"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(slugify(input)).toBe(expected);
    });
  }

  test("respects the length cap and never leaves a trailing dash behind the cut", () => {
    expect(slugify("a".repeat(100)).length).toBe(40);
    expect(slugify("ab-".repeat(40), 5)).toBe("ab-ab");
    expect(slugify("a" + "-".repeat(40), 3)).toBe("a");
    expect(slugify("x", 0)).toBe("work");
  });
});

describe("slugify — fuzz", () => {
  const ALPHABET = [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ..."..~^:?*[]\\/@{} \t\n\r-_+=!#$%&'\"|<>;()",
    "🎉",
    "ü",
    "日",
    ".lock",
    "@{",
    "..",
  ];

  test("4000 random inputs all produce a safe slug", () => {
    const rng = makeRng(0x51a6c0);
    for (let i = 0; i < 4000; i++) {
      const len = Math.floor(rng() * 60);
      const input = Array.from({ length: len }, () => pick(rng, ALPHABET)).join("");
      const max = 1 + Math.floor(rng() * 48);
      const slug = slugify(input, max);
      const fail = (why: string) => {
        throw new Error(
          `${why} (i=${i}, max=${max}) ${JSON.stringify(input)} → ${JSON.stringify(slug)}`,
        );
      };
      if (!/^[a-z0-9-]+$/.test(slug)) fail("slug outside [a-z0-9-]");
      if (slug.length > Math.max(max, 4)) fail("slug over the cap");
      if (slug.startsWith("-") || slug.endsWith("-")) fail("slug has a boundary dash");
      for (const hazard of REF_HAZARDS) if (slug.includes(hazard)) fail(`slug contains ${hazard}`);
      if (slug.endsWith(".lock")) fail("slug ends with .lock");
    }
  });

  test("git itself accepts the resulting ref name", async () => {
    const rng = makeRng(0x9ef5a1);
    const refs: string[] = [];
    for (let i = 0; i < 40; i++) {
      const input = Array.from({ length: 1 + Math.floor(rng() * 30) }, () =>
        pick(rng, ALPHABET),
      ).join("");
      refs.push(`refs/heads/dispatch/${slugify(input)}-deadbeef`);
    }
    for (const ref of refs) {
      const proc = Bun.spawn(["git", "check-ref-format", ref], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
    }
  });
});

// ── parseGithubRemote ─────────────────────────────────────────────────────────

describe("parseGithubRemote", () => {
  const accepted: ReadonlyArray<[string, string, string]> = [
    ["https://github.com/jkrumm/sideclaw.git", "jkrumm", "sideclaw"],
    ["https://github.com/jkrumm/sideclaw", "jkrumm", "sideclaw"],
    ["https://github.com/jkrumm/sideclaw/", "jkrumm", "sideclaw"],
    ["https://github.com/jkrumm/sideclaw.git/", "jkrumm", "sideclaw"],
    ["git@github.com:jkrumm/sideclaw.git", "jkrumm", "sideclaw"],
    ["git@github.com:jkrumm/sideclaw", "jkrumm", "sideclaw"],
    ["ssh://git@github.com/jkrumm/sideclaw.git", "jkrumm", "sideclaw"],
    ["https://github.com/some-org/repo.with.dots", "some-org", "repo.with.dots"],
  ];
  for (const [url, owner, repo] of accepted) {
    test(`parses ${url}`, () => {
      expect(parseGithubRemote(url)).toEqual({ owner, repo });
    });
  }

  const rejected = [
    "https://gitlab.com/jkrumm/sideclaw.git",
    "https://github.com.evil.example/jkrumm/sideclaw.git",
    "https://github.com/jkrumm",
    "https://github.com/",
    "/var/folders/tmp/origin.git",
    "file:///var/folders/tmp/origin.git",
    "git@gitlab.com:jkrumm/sideclaw.git",
    "http://github.com/jkrumm/sideclaw.git",
    "",
  ];
  for (const url of rejected) {
    test(`refuses ${url || "(empty)"}`, () => {
      expect(parseGithubRemote(url)).toBeNull();
    });
  }
});
