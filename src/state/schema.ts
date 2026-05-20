import { type } from "arktype";
import {
  agentTypes,
  deviationCategories,
  deviationSeverities,
  findingSeverities,
  fixingSources,
  gateOutcomes,
  runStatuses,
  taskClasses,
  taskStatuses,
  verificationOutcomes,
} from "./types.js";

const runStatusSchema = type.enumerated(...runStatuses);
const taskStatusSchema = type.enumerated(...taskStatuses);
const agentTypeSchema = type.enumerated(...agentTypes);
const taskClassSchema = type.enumerated(...taskClasses);
const fixingSourceSchema = type.enumerated(...fixingSources);
const deviationSeveritySchema = type.enumerated(...deviationSeverities);
const deviationCategorySchema = type.enumerated(...deviationCategories);
const gateOutcomeSchema = type.enumerated(...gateOutcomes);
const verificationOutcomeSchema = type.enumerated(...verificationOutcomes);
const findingSeveritySchema = type.enumerated(...findingSeverities);

export const buildFailureSchema = type({
  id: "string",
  file: "string | null",
  line: "number | null",
  message: "string",
  rawText: "string",
});

const lineRangeSchema = type(["number", "number"]).or("null");

export const findingSchema = type({
  id: "string",
  severity: findingSeveritySchema,
  description: "string",
  filePath: "string | null",
  lineRange: lineRangeSchema,
});

export const deviationSchema = type({
  id: "string",
  severity: deviationSeveritySchema,
  category: deviationCategorySchema,
  description: "string",
  affectedFiles: "string[]",
});

export const taskOutputSchema = type({
  summary: "string",
  filesModified: "string[]",
  deviations: deviationSchema.array(),
  notes: "string",
});

export const perTaskGateVerdictSchema = type({
  status: gateOutcomeSchema,
  findings: findingSchema.array(),
});

export const critiqueVerdictSchema = type({
  round: "number",
  status: gateOutcomeSchema,
  findings: findingSchema.array(),
  newTests: "string[]",
});

export const gateVerdictSchema = type({
  level: "number",
  round: "number",
  status: gateOutcomeSchema,
  perTask: type.Record("string", perTaskGateVerdictSchema),
});

export const verificationRoundSchema = type({
  round: "number",
  finalBuildLogPath: "string",
  newFailures: buildFailureSchema.array(),
  attribution: type.Record("string", type("string[]")),
  rebuildFromLevel: "number | null",
  outcome: verificationOutcomeSchema,
});

export const taskSchema = type({
  id: "string",
  level: "number",
  sequence: "string",
  dependsOn: "string[]",
  objective: "string",
  planMarkdown: "string",
  agentType: agentTypeSchema,
  class: taskClassSchema,
  critiqueEnabled: "boolean",
  verifyCommands: "string[]",
  status: taskStatusSchema,
  fixingSource: fixingSourceSchema.or("null"),
  worktreePath: "string | null",
  output: taskOutputSchema.or("null"),
  commitSHA: "string | null",
  critiqueVerdicts: critiqueVerdictSchema.array(),
  amendmentRoundsTotal: "number",
  verificationFixRoundsTotal: "number",
});

export const runSchema = type({
  name: "string",
  specPath: "string",
  targetRepoPath: "string",
  integrationBranch: "string",
  baselineBuildLogPath: "string",
  baselineFailures: buildFailureSchema.array(),
  commitStrategy: "'per-task'",
  status: runStatusSchema,
  tasks: taskSchema.array(),
  levelBoundaries: type.Record("string", "string"),
  gateVerdicts: gateVerdictSchema.array(),
  verificationRounds: verificationRoundSchema.array(),
  createdAt: "string",
});
