export const runStatuses = [
  "planning",
  "gating-plan",
  "executing",
  "verifying",
  "fixing-verification",
  "consolidating",
  "done",
  "failed",
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const taskStatuses = [
  "pending",
  "running",
  "submitted",
  "critiquing",
  "amend_requested",
  "committed",
  "fixing",
  "completed",
  "failed",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const agentTypes = ["intern", "general", "explore"] as const;
export type AgentType = (typeof agentTypes)[number];

export const taskClasses = ["feature", "bugfix"] as const;
export type TaskClass = (typeof taskClasses)[number];

export const fixingSources = ["critique", "verification"] as const;
export type FixingSource = (typeof fixingSources)[number];

export const deviationSeverities = ["minor", "moderate", "major"] as const;
export type DeviationSeverity = (typeof deviationSeverities)[number];

export const deviationCategories = [
  "scope",
  "approach",
  "missing-test",
  "unreported-modification",
  "other",
] as const;
export type DeviationCategory = (typeof deviationCategories)[number];

export const gateOutcomes = ["pass", "amend", "fail"] as const;
export type GateOutcome = (typeof gateOutcomes)[number];

export const verificationOutcomes = ["pass", "retry", "escalated"] as const;
export type VerificationOutcome = (typeof verificationOutcomes)[number];

export const findingSeverities = ["blocking", "advisory"] as const;
export type FindingSeverity = (typeof findingSeverities)[number];

export type BuildFailure = {
  id: string;
  file: string | null;
  line: number | null;
  message: string;
  rawText: string;
};

export type Finding = {
  id: string;
  severity: FindingSeverity;
  description: string;
  filePath: string | null;
  lineRange: [number, number] | null;
};

export type Deviation = {
  id: string;
  severity: DeviationSeverity;
  category: DeviationCategory;
  description: string;
  affectedFiles: string[];
};

export type TaskOutput = {
  summary: string;
  filesModified: string[];
  deviations: Deviation[];
  notes: string;
};

export type CritiqueVerdict = {
  round: number;
  status: GateOutcome;
  findings: Finding[];
  newTests: string[];
};

export type PerTaskGateVerdict = {
  status: GateOutcome;
  findings: Finding[];
};

export type GateVerdict = {
  level: number;
  round: number;
  status: GateOutcome;
  perTask: Record<string, PerTaskGateVerdict>;
};

export type VerificationRound = {
  round: number;
  finalBuildLogPath: string;
  newFailures: BuildFailure[];
  attribution: Record<string, string[]>;
  rebuildFromLevel: number | null;
  outcome: VerificationOutcome;
};

export type Task = {
  id: string;
  level: number;
  sequence: string;
  dependsOn: string[];
  objective: string;
  planMarkdown: string;
  agentType: AgentType;
  class: TaskClass;
  critiqueEnabled: boolean;
  verifyCommands: string[];
  status: TaskStatus;
  fixingSource: FixingSource | null;
  worktreePath: string | null;
  output: TaskOutput | null;
  commitSHA: string | null;
  critiqueVerdicts: CritiqueVerdict[];
  amendmentRoundsTotal: number;
  verificationFixRoundsTotal: number;
};

export const verificationModes = [
  "baseline-equality",
  "no-new-failures",
  "skip-comparison",
] as const;
export type VerificationMode = (typeof verificationModes)[number];

export type Run = {
  name: string;
  specPath: string;
  targetRepoPath: string;
  integrationBranch: string;
  baselineBuildLogPath: string;
  baselineFailures: BuildFailure[];
  commitStrategy: "per-task";
  status: RunStatus;
  tasks: Task[];
  levelBoundaries: Record<number, string>;
  gateVerdicts: GateVerdict[];
  verificationRounds: VerificationRound[];
  /**
   * Phase 5 verification mode. Defaults to `baseline-equality` for runs
   * created before the planner emitted this field. The planner selects
   * the mode based on the spec — see `verificationModes` in
   * `agents/planner-types.ts` for the semantics of each.
   */
  verificationMode: VerificationMode;
  /**
   * Planner-supplied justification for `verificationMode`. Recorded so
   * the final report can show why a given run did or did not run
   * Phase 5 in strict mode.
   */
  verificationModeRationale: string;
  createdAt: string;
};
