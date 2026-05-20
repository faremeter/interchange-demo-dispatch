// Production shell helpers for the Phase-5 build gate and per-task
// verifier.
//
// The orchestrator's Phase 5 wiring (`runDispatch` in `index.ts`) injects
// a `BuildGateRunner` and a `TaskVerifier`. In tests these are scripted
// stubs; in production they are the helpers in this file.
//
// Both helpers spawn each configured shell command sequentially via the
// caller's `$SHELL -c <command>`, capture combined stdout+stderr, and emit
// the same per-command header sections that `baseline.ts` writes for the
// baseline log. That format is what the Phase-5 normalizer
// (`normalizeBuildOutput`) is calibrated against — keeping the runner's
// output shape identical to the baseline's is what lets `sameOutput`
// recognize an unchanged build.
//
// Contract decisions where the brief was ambiguous:
//
//   - `BuildGateRunner` is constructed by a factory that closes over the
//     resolved `buildGate` command list. The runner type
//     (`{ run, worktreePath } => …`) has no `commands` argument and the
//     `Run` document does not carry the dispatch-config path, so the
//     orchestrator must load `dispatch-config.yaml` once via
//     `loadDispatchConfig` and hand the commands to the factory at wire
//     time. The runner's `cwd` is the level worktree path — that is the
//     same surface Phase 5 already passes to it, and matches how
//     `baseline.ts` runs against `targetRepoPath`.
//
//   - All commands are run regardless of intermediate failures, matching
//     `captureBaseline`. A baseline that fail-fasted on the first error
//     would mask later regressions; the gate runner needs symmetric
//     behavior or the normalizer's comparison breaks.
//
//   - The runner's `exitCode` is the first non-zero exit code observed,
//     or 0 if every command exits 0. A `null` exit code (process killed
//     by signal) is surfaced as `null` and treated as failure for the
//     purposes of "first non-zero" selection.
//
//   - `defaultTaskVerifier` runs `task.verifyCommands` under
//     `task.worktreePath`. If the task's list is empty, it falls back to
//     the configured `buildGate` (so the factory takes the same
//     `buildGate` array as the gate runner). This matches the brief and
//     keeps the empty-list semantics from leaking into the type.
//     `ok` is true iff every command exits 0; output is the concatenated
//     header+body for every command, identical to the gate runner's
//     format.

import { spawn } from "node:child_process";

import type { Task } from "../state/index.js";

import type {
  BuildGateRunner,
  TaskVerifier,
} from "./phase5/index.js";

export interface CreateDefaultBuildGateRunnerOptions {
  /** Ordered shell commands from `dispatch-config.yaml`'s `buildGate`. */
  readonly buildGate: readonly string[];
}

/**
 * Build a `BuildGateRunner` that runs `buildGate` commands sequentially
 * under the supplied worktree path and emits a combined log shaped like
 * `baseline.ts`'s output.
 */
export function createDefaultBuildGateRunner(
  options: CreateDefaultBuildGateRunnerOptions,
): BuildGateRunner {
  if (options.buildGate.length === 0) {
    throw new Error(
      "createDefaultBuildGateRunner: buildGate must contain at least one command",
    );
  }
  const commands = [...options.buildGate];

  return async ({ worktreePath }) => {
    return runCommandsCollecting(commands, worktreePath);
  };
}

export interface CreateDefaultTaskVerifierOptions {
  /**
   * Ordered shell commands from `dispatch-config.yaml`'s `buildGate`,
   * used as the fallback when a task's `verifyCommands` is empty.
   */
  readonly buildGate: readonly string[];
}

/**
 * Build a `TaskVerifier` that runs `task.verifyCommands` (or the
 * configured `buildGate` when the task list is empty) under the task's
 * worktree and reports success iff every command exits 0.
 */
export function createDefaultTaskVerifier(
  options: CreateDefaultTaskVerifierOptions,
): TaskVerifier {
  if (options.buildGate.length === 0) {
    throw new Error(
      "createDefaultTaskVerifier: buildGate fallback must contain at least one command",
    );
  }
  const fallback = [...options.buildGate];

  return async ({ task }) => {
    const cwd = resolveTaskCwd(task);
    const commands =
      task.verifyCommands.length > 0 ? task.verifyCommands : fallback;
    const { output, exitCode } = await runCommandsCollecting(commands, cwd);
    return { ok: exitCode === 0, output };
  };
}

function resolveTaskCwd(task: Task): string {
  if (task.worktreePath === null) {
    throw new Error(
      `defaultTaskVerifier: task ${task.id} has no worktreePath; cannot run verify commands`,
    );
  }
  return task.worktreePath;
}

interface RunCollected {
  readonly output: string;
  readonly exitCode: number | null;
}

async function runCommandsCollecting(
  commands: readonly string[],
  cwd: string,
): Promise<RunCollected> {
  const sections: string[] = [];
  let firstFailure: number | null | undefined;
  for (const command of commands) {
    const result = await spawnCombined(command, cwd);
    sections.push(formatSection(command, cwd, result));
    if (firstFailure === undefined && result.exitCode !== 0) {
      firstFailure = result.exitCode;
    }
  }
  const exitCode = firstFailure === undefined ? 0 : firstFailure;
  return { output: sections.join("\n"), exitCode };
}

interface SpawnResult {
  readonly exitCode: number | null;
  readonly output: string;
}

function formatSection(
  command: string,
  cwd: string,
  result: SpawnResult,
): string {
  const exitLabel =
    result.exitCode === null ? "signaled" : String(result.exitCode);
  const header = `$ ${command}\n# cwd: ${cwd}\n# exit: ${exitLabel}\n`;
  return `${header}${result.output}`;
}

function spawnCombined(command: string, cwd: string): Promise<SpawnResult> {
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
      reject(
        new Error(`failed to spawn '${command}': ${err.message}`, {
          cause: err,
        }),
      );
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolvePromise({ exitCode: code, output });
    });
  });
}

