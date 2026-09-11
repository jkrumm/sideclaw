// Shared, pure plain-text/ANSI rendering primitives — split out of server/lib/agents.ts so
// server/lib/warden-board.ts's `renderWardenBlock` can share them without either module
// importing a *value* from the other (agents.ts imports `renderWardenBlock` from
// warden-board.ts; a reverse value import back into agents.ts would be a cycle). Neither file
// owns these — both are callers.

// ── ANSI colour (opt-in, `?color=1`/`?ansi=1` on the .txt routes) ──────────────────────────────
//
// SGR only, no 256/truecolor — this renders in a herdr pane via `watch --color`, and plain
// output must stay byte-identical when the flag is absent. Every coloured span resets before
// the newline, so a truncated line or a terminal that dies mid-stream never leaks colour into
// whatever follows.

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const MAGENTA = "\x1b[35m";
export const BOLD_RED = `${BOLD}${RED}`;
export const DIM_GREEN = `${DIM}${GREEN}`;

/** Strips SGR escape sequences — used by tests to assert `stripAnsi(coloured) === plain`, and
 *  internally to measure a coloured line's VISIBLE width for the 110-char clamp (never the
 *  escape bytes). A manual scan rather than a `/\x1b.../ ` regex literal — oxlint's
 *  `no-control-regex` flags the literal ESC byte in a regex pattern regardless of intent. */
export function stripAnsi(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Floor for a narrow-terminal (`?cols=`) title/text budget, so an aggressively narrow width
 *  never collapses a title to nothing. */
export const MIN_TITLE_CHARS = 20;

/** Clamps a (possibly ANSI-coloured) line to `maxChars` VISIBLE characters, passing escape
 *  bytes through uncounted, and always closing with a reset so a mid-escape cut can never
 *  leak colour into the next line. No-ops (returns `line` unchanged) when already within
 *  budget, so an uncoloured caller pays nothing extra. */
export function clampVisible(line: string, maxChars: number): string {
  if (stripAnsi(line).length <= maxChars) return line;
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (visible >= maxChars) break;
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}${RESET}`;
}

/** Hard-cuts a plain (uncoloured) line to `maxChars`. Every call site passes its own budget
 *  explicitly — there is no legacy fixed default here. */
export function clampLine(line: string, maxChars: number): string {
  return line.length > maxChars ? line.slice(0, maxChars) : line;
}

/** Truncates with an elided "…" when over budget — shared by every renderer and by the
 *  `overview`/`narrative` prompt builders, which need identical truncation to the text they
 *  describe. */
export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** "N ago" phrasing shared by every renderer and by the `overview` job's prompt builder, which
 *  needs identical relative-age text for the facts it hands the LLM — one source of truth for
 *  the format, not a second copy. */
export function relativeAge(ms: number | null, now: number): string {
  if (ms == null) return "?";
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h`;
  const deltaDay = Math.round(deltaHour / 24);
  return `${deltaDay}d`;
}

/** Drops the C0 bytes dotfiles' human-queue.sh `printable()` drops (`\t`, `\n`, `\r` kept —
 *  callers collapse whitespace themselves). Text reaching a renderer here can originate from
 *  an agent, an alert, or a ledger item written by an attacker-influenced process (an issue
 *  title, alert text) — a stray ESC or control byte must never reach a coloured terminal pane
 *  or Hermes. A char-code scan for the same reason `stripAnsi` is one: `no-control-regex`. */
export function stripControlBytes(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    if (!control) out += ch;
  }
  return out;
}
