// The `review` scope vocabulary, shared by review.ts (git diff, fallow) and ocr.ts — one
// grammar instead of three drifting copies. Scopes are already validated by review.ts's
// `validateScope` before they reach any of these.

/** A file-path scope (`/abs/path`, `src/foo.ts`) rather than a ref or range. Heuristic, and
 *  deliberately unchanged from the original `scopeDiffArgs` rule: a dotted ref such as a
 *  `v2.0` tag reads as a path, so pass `v2.0..HEAD` to review a tag. */
export function isPathScope(scope: string): boolean {
  return !scope.includes("..") && (scope.startsWith("/") || scope.includes("."));
}

/** Split `a..b` / `a...b` into its halves (either may be empty, as git allows); `null` for
 *  anything that is not a range. */
export function splitRange(scope: string): { from: string; to: string } | null {
  const match = scope.match(/^(.*?)\.\.\.?(.*)$/);
  if (!match) return null;
  return { from: match[1] ?? "", to: match[2] ?? "" };
}
