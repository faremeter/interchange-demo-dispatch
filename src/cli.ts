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
  return runDispatchVerb(argv);
}

async function runDispatchVerb(argv: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let skipBaseline = false;
  for (const arg of argv) {
    if (arg === "--skip-baseline") {
      skipBaseline = true;
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
  const options: RunDispatchOptions = {
    resume,
    // Default trace sink writes one line per noteworthy agent event to
    // stderr. Keeps stdout reserved for the report path. Operators who
    // want silence can pipe stderr to /dev/null; tests / library callers
    // pass their own `trace` (or omit it entirely).
    trace: (line) => {
      process.stderr.write(`${line}\n`);
    },
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
