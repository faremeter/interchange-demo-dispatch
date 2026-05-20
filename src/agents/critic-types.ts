// Arktype schemas for the critic / gate-critic tool surfaces.
//
// These schemas validate the *arguments* the model passes to the terminal
// tools (`recordVerdict` for per-task critics, `recordGateVerdict` for
// gate critics). They are intentionally separate from the persistence
// schemas in `src/state/schema.ts`: the persistence schemas describe what
// gets written to `run-state.yaml` after the orchestrator has stamped on
// fields the model never sees (e.g. `round` on a critique verdict, which
// the orchestrator owns, not the agent). The agent-facing schemas are the
// validation boundary at the tool surface.
//
// Scope note: spec.md §247-§260 and §588-§610 are the definitive shape for
// these verdicts. The PoC deliberately omits the prose skill's
// `validation` / `skipped-validation` / mutation-testing fields — they
// appear in the dispatch skill prose but not in spec.md, and this brief
// scopes them out. See the task notes for the full reasoning.

import { type } from "arktype";

import { findingSeverities, gateOutcomes } from "../state/types.js";

const findingSeveritySchema = type.enumerated(...findingSeverities);
const gateOutcomeSchema = type.enumerated(...gateOutcomes);

const lineRangeSchema = type(["number", "number"]).or("null");

/**
 * A single critic finding. Mirrors `state.types.Finding` but is its own
 * validation boundary so the tool surface owns what it accepts from the
 * model. The orchestrator (5d-gate-level) is responsible for copying these
 * into the persisted `CritiqueVerdict.findings` / `PerTaskGateVerdict.findings`
 * arrays.
 */
export const findingSchema = type({
  id: "string",
  severity: findingSeveritySchema,
  description: "string",
  filePath: "string | null",
  lineRange: lineRangeSchema,
});

export type CriticFinding = typeof findingSchema.infer;

/**
 * Arguments for the per-task `recordVerdict` terminal tool. Matches
 * spec.md §251 with the addition of `newTests` per §603-§609 — the critic
 * may name test files it wants added to the responsible task's
 * `filesModified` before the next rebuild. The orchestrator creates the
 * stubs / lets the fix agent author content; critics themselves have no
 * write access.
 */
export const criticVerdictSchema = type({
  taskId: "string",
  status: gateOutcomeSchema,
  findings: findingSchema.array(),
  "newTests?": "string[]",
});

export type CriticVerdict = typeof criticVerdictSchema.infer;

/**
 * A single per-task entry inside a gate verdict. The gate critic
 * summarizes each task in the level it is gating; the orchestrator uses
 * these to decide which tasks enter the amendment loop.
 */
export const perTaskGateVerdictSchema = type({
  status: gateOutcomeSchema,
  findings: findingSchema.array(),
});

export type PerTaskCriticGateVerdict = typeof perTaskGateVerdictSchema.infer;

/**
 * Arguments for the per-level `recordGateVerdict` terminal tool. Matches
 * spec.md §257 and §164-§170. The schema deliberately omits the prose
 * skill's mutation-testing fields (`validation`, `skipped-validation`):
 * spec.md does not require them and the PoC scope explicitly excludes
 * `validate-fix`.
 */
export const gateVerdictSchema = type({
  level: "number",
  status: gateOutcomeSchema,
  perTask: type.Record("string", perTaskGateVerdictSchema),
});

export type GateCriticVerdict = typeof gateVerdictSchema.infer;
