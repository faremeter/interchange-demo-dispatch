#!/usr/bin/env node

// `interchange-demo-dispatch` command-line entry point.
//
// Two verbs:
//
//   interchange-demo-dispatch [run-name] [--skip-baseline] [--scripts <path>]
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
//
// `--scripts <path>` is a test-only escape hatch. The CLI dynamically
// imports the supplied module and treats every named export as a
// candidate `RunDispatchOptions` override. Production users have no
// reason to pass it; the PoC end-to-end tests use it to inject
// scripted runners so the CLI can be exercised without real model
// providers.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * not declare a `provider` block at all (the caller may be running in
 * `--scripts` mode where the scripted overrides never reach the model);
 * throws loudly when the block IS declared but the API key env var is
 * missing — that combination is unambiguously a misconfiguration.
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
  let scriptsPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--skip-baseline") {
      skipBaseline = true;
      continue;
    }
    if (arg === "--scripts") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--scripts requires a path argument");
      }
      scriptsPath = next;
      i += 1;
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

  // Wire 7b's resume as the default options.resume so the CLI picks up
  // any previously-persisted run state. `--scripts` callers can override
  // by exporting their own `resume` from the scripts module.
  // Build production provider credentials from dispatch-config.yaml +
  // OPENCODE_API_KEY env var. Skipped silently if the config has no
  // provider block (then `--scripts` is expected to supply runners that
  // never reach the model).
  const credentials = await loadProviderCredentialsFromEnv(dispatchConfigPath);
  const baseOptions: RunDispatchOptions = {
    resume,
    ...(credentials !== null ? { provider: credentials } : {}),
  };
  const overrides =
    scriptsPath === null ? {} : await loadScripts(scriptsPath);
  const options: RunDispatchOptions = { ...baseOptions, ...overrides };
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
 * Test-only escape hatch: dynamic-import the supplied module and
 * treat its named exports (or its default export, when that is a
 * function returning a bag) as `RunDispatchOptions`. The orchestrator
 * itself validates every callback's invocation, so this loader only
 * checks coarse shapes (object-shaped, function-where-expected) and
 * leaves the per-field correctness to runtime call sites. The
 * boundary cast on the final return is the narrow place where typed
 * `RunDispatchOptions` meets the dynamically loaded module.
 */
async function loadScripts(scriptsPath: string): Promise<RunDispatchOptions> {
  const absolute = resolve(process.cwd(), scriptsPath);
  const url = pathToFileURL(absolute).href;
  const imported: unknown = await import(url);
  if (typeof imported !== "object" || imported === null) {
    throw new Error(`--scripts module at ${absolute} did not produce an object export`);
  }
  const defaultExport: unknown = Reflect.get(imported, "default");
  let bag: unknown = imported;
  if (typeof defaultExport === "function") {
    const fn = defaultExport;
    const produced: unknown = await Promise.resolve(Reflect.apply(fn, undefined, []));
    bag = produced;
  } else if (typeof defaultExport === "object" && defaultExport !== null) {
    bag = defaultExport;
  }
  if (typeof bag !== "object" || bag === null) {
    throw new Error(`--scripts module at ${absolute} did not resolve to an object`);
  }
  validateScriptsBag(bag);
  return bag as RunDispatchOptions;
}

const RUN_DISPATCH_FUNCTION_KEYS = [
  "resume",
  "plannerOverride",
  "directorFactory",
  "greybeardDirectorFactory",
  "greybeardSpawner",
  "operatorResolver",
  "criticRunner",
  "gateCriticRunner",
  "fixAgentRunner",
  "phase5FixAgentRunner",
  "attributionRunner",
  "buildGateRunner",
  "taskVerifier",
  "notify",
] as const;

/**
 * Coarse shape check for the `--scripts` module: every known
 * function field must actually be a function, and `provider` must
 * be the documented `{ baseURL, apiKey }` object. Anything else is
 * left for the orchestrator's per-call validation to surface.
 */
function validateScriptsBag(bag: object): void {
  for (const key of RUN_DISPATCH_FUNCTION_KEYS) {
    const value: unknown = Reflect.get(bag, key);
    if (value === undefined) continue;
    if (typeof value !== "function") {
      throw new Error(`--scripts module export "${key}" must be a function`);
    }
  }
  const provider: unknown = Reflect.get(bag, "provider");
  if (provider !== undefined) {
    if (
      typeof provider !== "object" ||
      provider === null ||
      typeof Reflect.get(provider, "baseURL") !== "string" ||
      typeof Reflect.get(provider, "apiKey") !== "string"
    ) {
      throw new Error(`--scripts module export "provider" must be { baseURL, apiKey }`);
    }
  }
  const verifyMaxLoops: unknown = Reflect.get(bag, "verifyMaxLoops");
  if (verifyMaxLoops !== undefined && typeof verifyMaxLoops !== "number") {
    throw new Error(`--scripts module export "verifyMaxLoops" must be a number`);
  }
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
