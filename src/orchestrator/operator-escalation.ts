// Operator escape hatch.
//
// When Karen's policy (or a greybeard verdict) demands operator input, the
// orchestrator pauses by writing `pending-escalation.yaml` into the run
// directory and polling the same file until the operator sets `resolution`
// to either `continue` or `abort`. The orchestrator removes the file once
// resolution arrives and returns the chosen value to the caller.
//
// UX trade-off (PoC scope):
//
//   The escape hatch is a polled YAML file rather than an interactive prompt
//   on stdin. This keeps the orchestrator usable in batch / CI environments
//   where there is no controlling TTY (e.g., the dispatch script itself
//   running unattended) but means the operator must learn one extra file
//   format and convention. We pick polling over an OS-level file watcher
//   because polling is portable and the operator-induced latency dominates
//   anyway — a 1-second poll interval is well below the operator's
//   inspect-and-respond loop.
//
//   The hatch also enforces a configurable timeout (default 1 hour). Without
//   a timeout, a stale `pending-escalation.yaml` from a previous run could
//   silently block the orchestrator forever; the timeout converts that
//   scenario into a loud failure.

import { rm, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYAML, parse as parseYAML } from "yaml";

export type OperatorResolution = "continue" | "abort";

export interface AwaitOperatorResolutionOptions {
  /**
   * Absolute path to the run directory (e.g.,
   * `<repoRoot>/dispatch/<runName>`). The escalation file is written as
   * `<runDir>/pending-escalation.yaml`.
   */
  runDir: string;
  /**
   * Human-readable description of why the orchestrator is escalating. Written
   * into the YAML as `reason` so the operator sees the context next to the
   * resolution field they need to edit.
   */
  reason: string;
  /**
   * Free-form structured details written under `details` in the YAML. The
   * orchestrator typically writes the task id, deviation id, severity, and
   * the chain of Karen / greybeard decisions that led to the escalation.
   */
  details?: Record<string, unknown>;
  /**
   * Poll interval in milliseconds. Defaults to 1000ms (1s). Tests typically
   * set this to a small value (e.g., 5ms) so the test does not idle.
   */
  pollIntervalMs?: number;
  /**
   * Hard timeout in milliseconds. Defaults to 3_600_000ms (1 hour). A timed-
   * out escalation throws `OperatorEscalationTimeoutError` so the caller can
   * surface the stall to whoever is watching the orchestrator's stdout.
   */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export const PENDING_ESCALATION_FILENAME = "pending-escalation.yaml";

export class OperatorEscalationTimeoutError extends Error {
  override name = "OperatorEscalationTimeoutError";
  constructor(
    public readonly file: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `operator did not resolve ${file} within ${String(elapsedMs)}ms; aborting`,
    );
  }
}

/**
 * Write `<runDir>/pending-escalation.yaml` and block until the operator edits
 * its `resolution` field. Returns `"continue"` or `"abort"` on success and
 * throws `OperatorEscalationTimeoutError` if the deadline passes without a
 * resolution.
 *
 * The function removes the escalation file before returning so the next
 * escalation does not see stale state. If the polling loop is interrupted by
 * an error (e.g., the file is deleted out from under it), the function lets
 * the error surface; the orchestrator is expected to treat such failures as
 * fatal because the operator escape hatch has lost its medium of
 * communication.
 */
export async function awaitOperatorResolution(
  options: AwaitOperatorResolutionOptions,
): Promise<OperatorResolution> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const escalationPath = join(options.runDir, PENDING_ESCALATION_FILENAME);

  const document = {
    reason: options.reason,
    details: options.details ?? {},
    resolution:
      "<<edit this value to continue|abort and save the file to resume the run>>",
    createdAt: new Date().toISOString(),
  };
  await writeFile(escalationPath, stringifyYAML(document), "utf8");

  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const resolution = await tryReadResolution(escalationPath);
      if (resolution !== null) return resolution;
      if (Date.now() >= deadline) {
        throw new OperatorEscalationTimeoutError(escalationPath, timeoutMs);
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    await rm(escalationPath, { force: true });
  }
}

async function tryReadResolution(
  escalationPath: string,
): Promise<OperatorResolution | null> {
  try {
    await stat(escalationPath);
  } catch {
    // The operator may have deleted the file as their resolution channel.
    // We treat the missing file as "unresolved" and continue polling; if the
    // operator wants to abort, they edit the file rather than removing it.
    return null;
  }
  const raw = await readFile(escalationPath, "utf8");
  // A YAML parse failure here is treated as "still unresolved" rather than
  // a hard error: the operator may be editing the file with a non-atomic
  // editor and the polling loop will see a well-formed document on the
  // next iteration. This is the only place the defensive-errors-surface
  // policy is relaxed because the alternative (hard failure on a mid-write
  // snapshot) would force every operator to learn to use atomic writes.
  let parsed: unknown;
  try {
    parsed = parseYAML(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("resolution" in parsed)) return null;
  const value: unknown = parsed.resolution;
  if (value === "continue" || value === "abort") return value;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
