import { type } from "arktype";

import {
  deviationCategories,
  deviationSeverities,
} from "../state/types.js";

const deviationSeveritySchema = type.enumerated(...deviationSeverities);
const deviationCategorySchema = type.enumerated(...deviationCategories);

/**
 * Arktype schema for a single deviation entry the implementer reports back
 * through `submitOutput`. Mirrors `state.types.Deviation` but is named
 * separately so the implementer's tool surface owns its own validation
 * boundary — the model speaks to this schema, not directly to the state
 * model's persistence schema.
 */
export const submittedDeviationSchema = type({
  severity: deviationSeveritySchema,
  category: deviationCategorySchema,
  description: "string",
  affectedFiles: "string[]",
});

export type SubmittedDeviation = typeof submittedDeviationSchema.infer;

/**
 * Arktype schema for the `submitOutput` terminal tool's arguments. Matches
 * the brief's `TaskOutput` shape (`summary`, `filesModified`, `deviations`,
 * `notes`) — the orchestrator (5b-run-level) converts this into the
 * persisted `TaskOutput` after collecting it.
 */
export const submittedOutputSchema = type({
  summary: "string",
  filesModified: "string[]",
  deviations: submittedDeviationSchema.array(),
  notes: "string",
});

export type SubmittedOutput = typeof submittedOutputSchema.infer;

/**
 * Arktype schema for a single `recordBuildResult` invocation. The agent
 * may call the tool repeatedly to log each build/lint/test command it
 * ran; the orchestrator inspects the accumulated array after the agent
 * submits to confirm the claimed evidence matches reality.
 */
export const recordedBuildSchema = type({
  command: "string",
  exitCode: "number",
  stdoutTail: "string",
});

export type RecordedBuild = typeof recordedBuildSchema.infer;
