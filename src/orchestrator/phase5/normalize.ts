// Build-output normalization for Phase 5's baseline comparison.
//
// The spec (spec.md §502-§519, §679-§697) is explicit that the
// Phase-5 comparator works over normalized text, not parsed
// structures. The normalizer's job is to strip volatile substrings
// that change between runs even when the underlying success/failure
// state has not — ANSI colour codes, timestamps, absolute worktree
// paths, runtime measurements, repeat-run line-number noise.
//
// Heuristics (each applied unconditionally over the full input):
//
//   1. ANSI escape sequences (CSI / SGR / terminal control codes) are
//      replaced with the empty string. The pattern matches the bare
//      `\x1b[...m` form and the broader CSI envelope.
//   2. ISO-8601 timestamps with optional fractional seconds and
//      timezone (e.g. `2024-05-20T10:11:12.345Z`) collapse to
//      `<TIMESTAMP>`.
//   3. Other common timestamp forms: `[HH:MM:SS]`, `HH:MM:SS.NNN`,
//      and millisecond-since-epoch literals embedded in JSON-ish
//      output collapse to `<TIMESTAMP>` too.
//   4. Absolute paths starting with the worktree directory collapse
//      to a `<WORKTREE>`-prefixed relative form. Paths inside an
//      OS temporary directory (e.g. `/var/folders/.../T/`) collapse
//      to `<TMP>` so per-run scratch dirs do not perturb the diff.
//   5. `Time: 123ms` / `Time: 1.23s` / `(123ms)` / `(1.234s)` style
//      runtime measurements collapse to `Time: <TIME>` (or
//      `<TIME>` inside parentheses).
//   6. Run-number / repeat suffixes that some test harnesses append
//      after a file path (`foo.ts:42:7 (re-run #3)`, `test #4`)
//      collapse to a single `<RUN>` placeholder.
//   7. Memory-address-looking hex literals (`0x` + 6+ hex digits)
//      and short `pid=<n>` annotations collapse to a placeholder
//      so process identifiers do not perturb the diff.
//
// Known false-positive risks documented per heuristic — these are
// PoC-grade rules that may collapse genuine differences if a tool
// happens to put a real ANSI sequence or `Time: 123ms` substring in
// a meaningful place. The spec acknowledges this and prefers
// false-positives ("entered the fix loop unnecessarily") over
// false-negatives ("real regression slipped through"). When a
// normalizer rule has to choose, it errs toward keeping text in
// place; the heuristics are deliberately conservative.

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const ISO_8601_PATTERN =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

const BRACKETED_CLOCK_PATTERN = /\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/g;
const BARE_CLOCK_PATTERN = /\b\d{2}:\d{2}:\d{2}\.\d{3}\b/g;
const EPOCH_MS_PATTERN = /\b1[0-9]{12}\b/g;

const TIME_NS_PATTERN =
  /\b[Tt]ime[:=]\s*\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|m|h)\b/g;
const PAREN_TIME_PATTERN =
  /\((?:\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|m|h))\)/g;
const ELAPSED_PATTERN =
  /\b(?:elapsed|took|duration|finished in)[:\s]+\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|m|h)\b/gi;

const RERUN_SUFFIX_PATTERN =
  /\((?:re-run|run|retry|attempt)\s*#?\s*\d+\)/gi;
const HASH_RUN_PATTERN = /\b(?:test|run)\s+#\d+\b/gi;

const HEX_ADDRESS_PATTERN = /\b0x[0-9a-fA-F]{6,}\b/g;
const PID_PATTERN = /\bpid[=:]\s*\d+\b/gi;

export interface NormalizeOptions {
  /**
   * Absolute path that should be collapsed to `<WORKTREE>` wherever it
   * appears in the build output. Required because Phase 5 runs in a
   * shared level worktree whose absolute path differs between runs.
   */
  readonly worktreePath: string;
  /**
   * Additional path prefixes to collapse (e.g. the run directory or
   * the target repo path). Each is replaced by its trailing `<NAME>`
   * placeholder, where `name` is the dirname's basename uppercased.
   * Optional; defaults to no extra prefixes.
   */
  readonly extraPathPrefixes?: readonly string[];
}

/**
 * Normalize a build-gate output string for the Phase-5 comparator. The
 * function is purely textual and applies all heuristics
 * unconditionally — the spec's design (§502-§519) treats every gate
 * output as opaque text.
 */
export function normalizeBuildOutput(
  text: string,
  options: NormalizeOptions,
): string {
  let out = text;
  out = out.replace(ANSI_PATTERN, "");
  out = collapseAbsolutePaths(out, options);
  out = out.replace(ISO_8601_PATTERN, "<TIMESTAMP>");
  out = out.replace(BRACKETED_CLOCK_PATTERN, "[<TIMESTAMP>]");
  out = out.replace(BARE_CLOCK_PATTERN, "<TIMESTAMP>");
  out = out.replace(EPOCH_MS_PATTERN, "<TIMESTAMP>");
  out = out.replace(TIME_NS_PATTERN, "Time: <TIME>");
  out = out.replace(PAREN_TIME_PATTERN, "(<TIME>)");
  out = out.replace(ELAPSED_PATTERN, "elapsed <TIME>");
  out = out.replace(RERUN_SUFFIX_PATTERN, "(<RUN>)");
  out = out.replace(HASH_RUN_PATTERN, "<RUN>");
  out = out.replace(HEX_ADDRESS_PATTERN, "<ADDR>");
  out = out.replace(PID_PATTERN, "pid=<PID>");
  out = trimTrailingWhitespacePerLine(out);
  return out;
}

/**
 * Compare two build-gate outputs by normalizing both and checking
 * equality. The orchestrator uses this for the baseline/final
 * regression check (spec.md §502-§519).
 */
export function sameOutput(
  a: string,
  b: string,
  options: NormalizeOptions,
): boolean {
  return normalizeBuildOutput(a, options) === normalizeBuildOutput(b, options);
}

function collapseAbsolutePaths(text: string, options: NormalizeOptions): string {
  let out = text;
  const worktree = stripTrailingSeparator(options.worktreePath);
  if (worktree.length > 0) {
    out = replaceAllLiteral(out, worktree, "<WORKTREE>");
  }
  for (const prefix of options.extraPathPrefixes ?? []) {
    const stripped = stripTrailingSeparator(prefix);
    if (stripped.length === 0) continue;
    out = replaceAllLiteral(out, stripped, placeholderFor(stripped));
  }
  out = out.replace(/\/(?:private\/)?var\/folders\/[^\s'"]+/g, "<TMP>");
  out = out.replace(/\/tmp\/[^\s'"]*/g, "<TMP>");
  return out;
}

function stripTrailingSeparator(p: string): string {
  if (p.length <= 1) return p;
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

function placeholderFor(absolutePath: string): string {
  const segments = absolutePath.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined || last.length === 0) return "<PATH>";
  return `<${last.toUpperCase()}>`;
}

function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  const parts: string[] = [];
  let index = 0;
  while (index <= haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) {
      parts.push(haystack.slice(index));
      break;
    }
    parts.push(haystack.slice(index, next));
    parts.push(replacement);
    index = next + needle.length;
  }
  return parts.join("");
}

function trimTrailingWhitespacePerLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
}
