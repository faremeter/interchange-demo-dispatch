// Baseline-build capture and failure extraction.
//
// `captureBaseline` runs the configured `buildGate` commands in order
// against the target repo, concatenates all output (stdout + stderr) into
// `dispatch/<run>/baseline-build.log`, and extracts a conservative list of
// `BuildFailure` records from that combined log.
//
// The parser is deliberately conservative for the PoC: it scans each line
// for a small set of failure markers (`error`, `FAIL`, ASCII/UTF cross
// markers) and pulls an optional `file:line` location out of the same line
// when present. Known limitations the caller (and Phase 5) must be aware
// of:
//
//   - False positives: any informational line containing the substring
//     "error" (e.g. a doc-string discussing error handling, or a tool's
//     own usage text) becomes a failure record.
//   - False negatives: tools that report failures with non-English or
//     non-standard markers (`erreur`, `panic`, `assertion`) are missed.
//   - Multi-line context (e.g. stack traces) is not aggregated; each
//     matching line becomes its own record.
//
// The `id` field on each `BuildFailure` is a stable hash of
// `(file, line, normalized message)` so Phase 5's "same failures"
// comparison survives reordering and ANSI-stripping. `rawText` preserves
// the original line verbatim for the normalizer.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BuildFailure } from "../state/index.js";

export interface CaptureBaselineResult {
  readonly logPath: string;
  readonly failures: BuildFailure[];
}

/**
 * Run each command in `buildGate` sequentially under `targetRepoPath`,
 * capture combined stdout+stderr to `logPath`, and parse failures from the
 * combined output. The commands are not stopped on first failure — every
 * command runs, because the build gate is a sequence the operator wants
 * exercised in full (a baseline that masked downstream failures behind a
 * fail-fast first command would be useless to Phase 5).
 *
 * Each command is invoked via the user's `$SHELL` with `-c <command>` so
 * the entries in `buildGate` may be ordinary shell pipelines (the spec
 * shows `bun run lint`, `bun run build`, `bun run test`, etc.).
 *
 * The returned `logPath` is the absolute path the log was written to.
 */
export async function captureBaseline(
  targetRepoPath: string,
  buildGate: string[],
  logPath: string,
): Promise<CaptureBaselineResult> {
  if (buildGate.length === 0) {
    throw new Error("captureBaseline called with an empty buildGate");
  }

  const absoluteLogPath = resolve(logPath);
  await mkdir(dirname(absoluteLogPath), { recursive: true });

  const sections: string[] = [];
  for (const command of buildGate) {
    const section = await runCommand(command, targetRepoPath);
    sections.push(section);
  }

  const combined = sections.join("\n");
  await writeFile(absoluteLogPath, combined, "utf8");

  const failures = parseBuildFailures(combined);

  return { logPath: absoluteLogPath, failures };
}

interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

async function runCommand(
  command: string,
  cwd: string,
): Promise<string> {
  const result = await spawnCombined(command, cwd);
  const header =
    `$ ${result.command}\n` +
    `# cwd: ${cwd}\n` +
    `# exit: ${result.exitCode === null ? "signaled" : String(result.exitCode)}\n`;
  return `${header}${result.output}`;
}

function spawnCombined(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const shell = process.env["SHELL"];
    if (!shell) {
      reject(new Error("SHELL environment variable is not set"));
      return;
    }

    const child = spawn(shell, ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => chunks.push(data));

    child.on("error", (err) => {
      reject(new Error(`failed to spawn '${command}': ${err.message}`, { cause: err }));
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolvePromise({ command, exitCode: code, output });
    });
  });
}

// Markers we treat as failure-indicating when they appear in a line.
// Conservative on purpose — see file-level comment for the trade-offs.
const FAILURE_MARKERS = [
  /\berror\b/i,
  /\bFAIL(?:ED|URE|S)?\b/,
  /\bfailed\b/i,
  /✗/,
  /×/,
];

// Pull a `file:line` (or `file:line:col`) prefix out of a line, when one
// is present. The regex deliberately rejects lines that begin with a
// shell prompt (`$ `) or a header marker (`# `) we emit ourselves.
const FILE_LINE_PATTERN =
  /(?:^|\s)([^\s:][^\s:]*?\.[A-Za-z][A-Za-z0-9]*):(\d+)(?::(\d+))?/;

// Strip ANSI escape sequences (color codes etc.) when extracting messages.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g;

/**
 * Extract `BuildFailure` records from a combined build-gate log.
 *
 * Exported so Phase 5's final-build verifier can reuse the same parser
 * over its own log — the "same failures" comparison only makes sense if
 * both sides use identical extraction.
 */
export function parseBuildFailures(log: string): BuildFailure[] {
  const failures: BuildFailure[] = [];
  const lines = log.split(/\r?\n/);

  for (const line of lines) {
    if (lookLikeHeader(line)) continue;
    const stripped = line.replace(ANSI_PATTERN, "");
    if (!FAILURE_MARKERS.some((re) => re.test(stripped))) continue;

    const match = FILE_LINE_PATTERN.exec(stripped);
    const file = match ? match[1] ?? null : null;
    const line1 = match && match[2] ? Number.parseInt(match[2], 10) : null;

    const message = stripped.trim();
    const id = hashFailureId(file, line1, message);

    failures.push({
      id,
      file,
      line: line1,
      message,
      rawText: line,
    });
  }

  return failures;
}

function lookLikeHeader(line: string): boolean {
  return line.startsWith("$ ") || line.startsWith("# ");
}

function hashFailureId(
  file: string | null,
  line: number | null,
  message: string,
): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const key = `${file ?? ""}|${line === null ? "" : String(line)}|${normalized}`;
  const hash = createHash("sha1").update(key).digest("hex");
  return `bf-${hash.slice(0, 12)}`;
}
