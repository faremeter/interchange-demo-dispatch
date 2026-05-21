#!/usr/bin/env node

// `interchange-demo-dispatch` command-line entry point.
//
// Two verbs:
//
//   interchange-demo-dispatch [run-name] [--skip-baseline]
//       Run a dispatch against ./spec.md and ./dispatch-config.yaml in
//       cwd, materializing run state under
//       `<cwd>/dispatch/<run-name>/`. The run-name defaults to a
//       timestamp-derived identifier when omitted.
//
//   interchange-demo-dispatch teardown <run-name>
//       Remove every per-level worktree associated with the named
//       run. Does NOT delete the dispatch directory or its contents
//       — operator-inspectable state survives so the operator can
//       review the report.md and run-state.yaml.
//
// `--skip-baseline` is the operator-facing surface for
// `SpecRef.skipBaseline` (5a-orchestrator-init). Use it for
// greenfield bootstraps where the build gate does not yet exist.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  runDispatch,
  type ProviderCredentials,
  type RunDispatchOptions,
} from "./orchestrator/index.js";
import type { SpecRef } from "./orchestrator/index.js";
import { loadDispatchConfig } from "./orchestrator/config.js";
import { resume } from "./orchestrator/resume.js";
import { tearDownLevelWorktree } from "./orchestrator/worktree.js";
import { loadRun } from "./state/index.js";

const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";

/**
 * Build production-mode provider credentials from `dispatch-config.yaml`
 * + the `OPENCODE_API_KEY` env var. Returns `null` when the config does
 * not declare a `provider` block at all; throws loudly when the block
 * IS declared but the API key env var is missing — that combination is
 * unambiguously a misconfiguration.
 */
async function loadProviderCredentialsFromEnv(
  dispatchConfigPath: string,
): Promise<ProviderCredentials | null> {
  const config = await loadDispatchConfig(dispatchConfigPath);
  if (config.provider === undefined) return null;
  const apiKey = process.env[OPENCODE_API_KEY_ENV];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `dispatch-config.yaml declared a provider.baseURL but ${OPENCODE_API_KEY_ENV} is unset; export the env var to authenticate against ${config.provider.baseURL}`,
    );
  }
  if (config.provider.adapter === undefined) {
    throw new Error(
      `dispatch-config.yaml declared a provider.baseURL but provider.adapter is unset; set it to "openai" for opencode-go-style endpoints or "anthropic" for the Anthropic API`,
    );
  }
  return {
    baseURL: config.provider.baseURL,
    apiKey,
    adapter: config.provider.adapter,
  };
}

/* eslint-disable no-console */
async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "teardown") {
    return runTeardown(argv.slice(1));
  }
  if (argv[0] === "clean") {
    return runClean(argv.slice(1));
  }
  return runDispatchVerb(argv);
}

async function runDispatchVerb(argv: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let skipBaseline = false;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--skip-baseline") {
      skipBaseline = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const cwd = process.cwd();
  const specPath = resolve(cwd, "spec.md");
  const dispatchConfigPath = resolve(cwd, "dispatch-config.yaml");
  const runName = positional[0] ?? defaultRunName();

  const spec: SpecRef = {
    specPath,
    targetRepoPath: cwd,
    runName,
    dispatchConfigPath,
    ...(skipBaseline ? { skipBaseline: true } : {}),
  };

  const credentials = await loadProviderCredentialsFromEnv(dispatchConfigPath);
  // Default trace sink writes one line per noteworthy agent event to
  // stderr. Keeps stdout reserved for the report path. Operators who
  // want silence can pipe stderr to /dev/null; tests / library callers
  // pass their own `trace` (or omit it entirely). `--verbose` opts into
  // streaming thinking / terminal-text deltas line-by-line as they
  // arrive so the operator can watch the model reason in real time.
  const traceWrite = (line: string) => {
    process.stderr.write(`${line}\n`);
  };
  const trace = verbose
    ? { write: traceWrite, verbose: true }
    : traceWrite;
  const options: RunDispatchOptions = {
    resume,
    trace,
    ...(credentials !== null ? { provider: credentials } : {}),
  };
  const run = await runDispatch(spec, options);

  const reportPath = resolve(cwd, "dispatch", runName, "report.md");
  console.log(reportPath);
  if (run.status === "failed") return 1;
  return 0;
}

async function runTeardown(argv: readonly string[]): Promise<number> {
  const runName = argv[0];
  if (runName === undefined) {
    throw new Error("teardown requires a <run-name> argument");
  }
  const cwd = process.cwd();
  const runStatePath = resolve(cwd, "dispatch", runName, "run-state.yaml");
  const run = await loadRun(runStatePath);
  const seen = new Set<string>();
  for (const task of run.tasks) {
    if (task.worktreePath === null) continue;
    if (seen.has(task.worktreePath)) continue;
    seen.add(task.worktreePath);
    if (!(await pathExists(task.worktreePath))) continue;
    await tearDownLevelWorktree({
      worktreePath: task.worktreePath,
      repoRoot: run.targetRepoPath,
    });
  }
  console.log(`removed ${String(seen.size)} worktree(s) for run ${runName}`);
  return 0;
}

/**
 * Wipe a run from disk in full: removes every per-level worktree, every
 * `dispatch/<run-name>/...` branch, and the `dispatch/<run-name>/`
 * directory itself. Intended for the "I aborted a run, give me a clean
 * slate" workflow that operators previously had to handle with a
 * three-line shell incantation. Idempotent — surviving artifacts from
 * a partial run (no run-state.yaml, dangling worktrees, stale branches)
 * are removed best-effort.
 *
 * Usage:
 *
 *   interchange-demo-dispatch clean <run-name>      # one run
 *   interchange-demo-dispatch clean --all           # every run in cwd
 */
async function runClean(argv: readonly string[]): Promise<number> {
  const cwd = process.cwd();
  const dispatchRoot = resolve(cwd, "dispatch");

  let all = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  let runNames: string[];
  if (all) {
    if (positional.length > 0) {
      throw new Error("clean --all takes no run-name positional");
    }
    if (!(await pathExists(dispatchRoot))) {
      console.log(`no dispatch directory at ${dispatchRoot}; nothing to clean`);
      return 0;
    }
    const { readdir } = await import("node:fs/promises");
    runNames = await readdir(dispatchRoot);
  } else {
    const name = positional[0];
    if (name === undefined) {
      throw new Error(
        "clean requires either a <run-name> argument or --all to wipe every run",
      );
    }
    runNames = [name];
  }

  const { rm } = await import("node:fs/promises");
  for (const runName of runNames) {
    const runDir = resolve(dispatchRoot, runName);

    // Best-effort teardown via the persisted state, if it survived the
    // crash. Failures here are non-fatal — we fall through to the
    // git-level cleanup either way.
    const runStatePath = resolve(runDir, "run-state.yaml");
    if (await pathExists(runStatePath)) {
      try {
        const run = await loadRun(runStatePath);
        const seen = new Set<string>();
        for (const task of run.tasks) {
          if (task.worktreePath === null) continue;
          if (seen.has(task.worktreePath)) continue;
          seen.add(task.worktreePath);
          if (!(await pathExists(task.worktreePath))) continue;
          try {
            await tearDownLevelWorktree({
              worktreePath: task.worktreePath,
              repoRoot: run.targetRepoPath,
            });
          } catch {
            // Ignore; git-level prune below handles dangling state.
          }
        }
      } catch {
        // Run state was unreadable; fall through to brute-force cleanup.
      }
    }

    // Prune any worktrees git still knows about that point under the
    // (about-to-be-deleted) run dir, then delete every dispatch branch
    // for this run. `--force` is necessary because the branches were
    // checked out into worktrees we just removed and git considers them
    // unmerged.
    await spawnGitInherit(cwd, ["worktree", "prune"]);
    const branchPrefix = `dispatch/${runName}`;
    const branches = await listBranches(cwd);
    for (const branch of branches) {
      if (branch === branchPrefix || branch.startsWith(`${branchPrefix}-`)) {
        try {
          await spawnGitInherit(cwd, ["branch", "-D", branch]);
        } catch {
          // Branch may have already been deleted by the worktree
          // teardown above; harmless.
        }
      }
    }

    if (await pathExists(runDir)) {
      await rm(runDir, { recursive: true, force: true });
    }
    console.log(`cleaned ${runName}`);
  }

  // If we cleaned everything and the dispatch dir is now empty, remove
  // it so the working tree returns to its pre-run state.
  if (all && (await pathExists(dispatchRoot))) {
    const { readdir, rmdir } = await import("node:fs/promises");
    const remaining = await readdir(dispatchRoot);
    if (remaining.length === 0) {
      await rmdir(dispatchRoot);
    }
  }

  return 0;
}

async function spawnGitInherit(
  cwd: string,
  args: readonly string[],
): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn("git", [...args], { cwd, stdio: "ignore" });
    child.on("error", rejectSpawn);
    child.on("close", (code) => {
      if (code === 0) resolveSpawn();
      else rejectSpawn(new Error(`git ${args.join(" ")} exited ${String(code)}`));
    });
  });
}

async function listBranches(cwd: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  return new Promise<string[]>((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", rejectSpawn);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectSpawn(new Error(`git for-each-ref exited ${String(code)}`));
        return;
      }
      const out = Buffer.concat(chunks).toString("utf8").trim();
      resolveSpawn(out.length === 0 ? [] : out.split("\n"));
    });
  });
}

function defaultRunName(): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const HH = String(now.getUTCHours()).padStart(2, "0");
  const MM = String(now.getUTCMinutes()).padStart(2, "0");
  const SS = String(now.getUTCSeconds()).padStart(2, "0");
  return `run-${yyyy}${mm}${dd}-${HH}${MM}${SS}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`interchange-demo-dispatch: ${message}`);
    process.exit(1);
  },
);
/* eslint-enable no-console */
