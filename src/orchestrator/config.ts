// Dispatch configuration loader.
//
// Reads and validates `dispatch-config.yaml` from the target repository.
// The config carries two pieces the orchestrator needs at every stage:
//
//   - `buildGate`: the ordered shell commands the orchestrator runs to
//     verify the tree (captured pre-Phase-1 as the baseline, inherited by
//     tasks whose `verifyCommands` is empty, and re-run in Phase 5).
//   - `modelConfig`: per-role model selection (planner / implementer /
//     critic / gateCritic / greybeard / attribution / fixAgent).
//
// Per the spec, every model field defaults to `opencode-go/kimi-k2.6`
// — but the config file itself is required, and so is `buildGate`. We do
// not invent values: a missing or malformed file is a loud failure at
// init time.

import { type } from "arktype";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYAML } from "yaml";

export const modelConfigSchema = type({
  planner: "string",
  implementer: "string",
  critic: "string",
  gateCritic: "string",
  greybeard: "string",
  attribution: "string",
  fixAgent: "string",
});

export type ModelConfig = typeof modelConfigSchema.infer;

export const dispatchConfigSchema = type({
  buildGate: "string[]",
  modelConfig: modelConfigSchema,
});

export type DispatchConfig = typeof dispatchConfigSchema.infer;

/**
 * Read the dispatch config at `path`, parse it as YAML, and validate it
 * with arktype. Throws an `Error` (with the arktype errors object attached
 * as `cause`) on any of: missing file, malformed YAML, validation failure,
 * empty `buildGate`. Never returns a partially-valid config.
 */
export async function loadDispatchConfig(path: string): Promise<DispatchConfig> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf8");

  const parsed: unknown = parseYAML(raw);
  const validated = dispatchConfigSchema(parsed);

  if (validated instanceof type.errors) {
    throw new Error(
      `invalid dispatch-config YAML at ${absolute}: ${validated.summary}`,
      { cause: validated },
    );
  }

  if (validated.buildGate.length === 0) {
    throw new Error(
      `dispatch-config at ${absolute} has empty buildGate; the orchestrator requires at least one command`,
    );
  }

  return validated;
}
