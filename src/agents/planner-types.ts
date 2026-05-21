// Planner tool argument and result schemas.
//
// `proposeTask` is the repeatable tool the planner uses to submit one task
// at a time. The runtime accumulates every accepted proposal and runs the
// DAG validator (see `../dag-validate.ts`) when `finalizePlan` is called.
//
// The `planMarkdown` field is the load-bearing one: it is the full
// multi-section task plan body that downstream implementer / critic /
// greybeard / fix agents consume as their seed material (per the brief).
// Without a non-trivial body those agents would see only a one-sentence
// objective and could not act. The minimum-length check below is the
// schema-level guarantee.

import { type } from "arktype";

import { agentTypes, taskClasses } from "../state/types";

export const PLAN_MARKDOWN_MIN_LENGTH = 200;

export const proposeTaskArgsSchema = type({
  idHint: /^[a-z][a-z0-9-]*$/,
  level: "number.integer >= 1",
  dependsOn: "string[]",
  objective: "string > 0",
  planMarkdown: "string >= 200",
  agentType: "'intern' | 'general' | 'explore'",
  class: "'feature' | 'bugfix'",
  verifyCommands: "string[]",
  critiqueEnabled: "boolean",
});

export type ProposeTaskArgs = typeof proposeTaskArgsSchema.infer;

// Compile-time guarantee that the literal unions in the arktype schema
// match the run-state's enumerations. A mismatch (e.g. an agentType added
// to one but not the other) makes the build fail rather than silently
// accepting an unknown value.
type AgentTypeOk = ProposeTaskArgs["agentType"] extends (typeof agentTypes)[number]
  ? (typeof agentTypes)[number] extends ProposeTaskArgs["agentType"]
    ? true
    : false
  : false;
type ClassOk = ProposeTaskArgs["class"] extends (typeof taskClasses)[number]
  ? (typeof taskClasses)[number] extends ProposeTaskArgs["class"]
    ? true
    : false
  : false;
const _agentTypeOk: AgentTypeOk = true;
const _classOk: ClassOk = true;
void _agentTypeOk;
void _classOk;

// `verificationMode` drives Phase 5's behaviour over the captured baseline:
//
//   - `baseline-equality`: the post-run normalized build output must match
//     the baseline byte-for-byte (modulo path / timestamp normalization).
//     The correct choice for refactors, renames, migrations, and any other
//     "make the code work the same after these changes" spec.
//   - `no-new-failures`: the post-run output may differ from baseline, but
//     no NEW parsed failures may appear. Existing baseline failures may
//     disappear. The right choice for bug-fix specs and spec where the
//     baseline carries known-failing tests the work is expected to repair.
//   - `skip-comparison`: Phase 5 skips comparison entirely and proceeds
//     straight to consolidation. The right choice for additive specs that
//     legitimately change the build output (new tests, new modules, new
//     CLI binaries). The baseline log is still captured and persisted as a
//     diagnostic record; it just isn't used as a gate.
export const verificationModes = [
  "baseline-equality",
  "no-new-failures",
  "skip-comparison",
] as const;

export const finalizePlanArgsSchema = type({
  verificationMode:
    "'baseline-equality' | 'no-new-failures' | 'skip-comparison'",
  verificationModeRationale: "string > 0",
});
export type FinalizePlanArgs = typeof finalizePlanArgsSchema.infer;

// The proposal as the planner sees it. The runtime augments this with a
// generated `id` (derived from `idHint`) and the validated `level` when
// finalizing.
export interface ProposedTaskRecord {
  readonly idHint: string;
  readonly id: string;
  readonly level: number;
  readonly dependsOn: readonly string[];
  readonly objective: string;
  readonly planMarkdown: string;
  readonly agentType: ProposeTaskArgs["agentType"];
  readonly class: ProposeTaskArgs["class"];
  readonly verifyCommands: readonly string[];
  readonly critiqueEnabled: boolean;
}

export interface FinalizedPlan {
  readonly tasks: readonly ProposedTaskRecord[];
  readonly levels: Readonly<Record<string, number>>;
  readonly verificationMode: (typeof verificationModes)[number];
  readonly verificationModeRationale: string;
}
