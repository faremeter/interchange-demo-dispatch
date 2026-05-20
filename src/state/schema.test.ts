import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import {
  buildFailureSchema,
  critiqueVerdictSchema,
  deviationSchema,
  findingSchema,
  gateVerdictSchema,
  perTaskGateVerdictSchema,
  runSchema,
  taskOutputSchema,
  taskSchema,
  verificationRoundSchema,
} from "./schema.js";
import type {
  BuildFailure,
  CritiqueVerdict,
  Deviation,
  Finding,
  GateVerdict,
  Run,
  Task,
  TaskOutput,
  VerificationRound,
} from "./types.js";

// ---------------------------------------------------------------------------
// Compile-time harmony: arktype's inferred output type must be assignable
// to the hand-written TS type, and vice versa. If the schema drifts from
// the type definition, these helper declarations fail to compile.
// ---------------------------------------------------------------------------

function _assignableToTSType(
  bf: typeof buildFailureSchema.infer,
  f: typeof findingSchema.infer,
  d: typeof deviationSchema.infer,
  to: typeof taskOutputSchema.infer,
  cv: typeof critiqueVerdictSchema.infer,
  gv: typeof gateVerdictSchema.infer,
  vr: typeof verificationRoundSchema.infer,
  t: typeof taskSchema.infer,
  r: typeof runSchema.infer,
): void {
  const _bf: BuildFailure = bf;
  const _f: Finding = f;
  const _d: Deviation = d;
  const _to: TaskOutput = to;
  const _cv: CritiqueVerdict = cv;
  const _gv: GateVerdict = gv;
  const _vr: VerificationRound = vr;
  const _t: Task = t;
  const _r: Run = r;
  void [_bf, _f, _d, _to, _cv, _gv, _vr, _t, _r];
}

function _assignableFromTSType(
  bf: BuildFailure,
  f: Finding,
  d: Deviation,
  to: TaskOutput,
  cv: CritiqueVerdict,
  gv: GateVerdict,
  vr: VerificationRound,
  t: Task,
  r: Run,
): void {
  const _bf: typeof buildFailureSchema.infer = bf;
  const _f: typeof findingSchema.infer = f;
  const _d: typeof deviationSchema.infer = d;
  const _to: typeof taskOutputSchema.infer = to;
  const _cv: typeof critiqueVerdictSchema.infer = cv;
  const _gv: typeof gateVerdictSchema.infer = gv;
  const _vr: typeof verificationRoundSchema.infer = vr;
  const _t: typeof taskSchema.infer = t;
  const _r: typeof runSchema.infer = r;
  void [_bf, _f, _d, _to, _cv, _gv, _vr, _t, _r];
}

const validBuildFailure: BuildFailure = {
  id: "bf-1",
  file: "src/foo.ts",
  line: 42,
  message: "TS2304: Cannot find name 'bar'",
  rawText: "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
};

const validFinding: Finding = {
  id: "find-1",
  severity: "blocking",
  description: "missing input validation on user-supplied path",
  filePath: "src/state/persist.ts",
  lineRange: [10, 20],
};

const validDeviation: Deviation = {
  id: "dev-1",
  severity: "minor",
  category: "scope",
  description: "added a helper not in the plan",
  affectedFiles: ["src/state/types.ts"],
};

const validTaskOutput: TaskOutput = {
  summary: "implemented persistence",
  filesModified: ["src/state/persist.ts"],
  deviations: [validDeviation],
  notes: "round-trip test added",
};

const validTask: Task = {
  id: "2a-state-model",
  level: 2,
  sequence: "a",
  dependsOn: ["1a-bootstrap"],
  objective: "build the state model",
  planMarkdown: "# plan",
  agentType: "intern",
  class: "feature",
  critiqueEnabled: true,
  verifyCommands: ["bun test"],
  status: "pending",
  fixingSource: null,
  worktreePath: null,
  output: null,
  commitSHA: null,
  critiqueVerdicts: [],
  amendmentRoundsTotal: 0,
  verificationFixRoundsTotal: 0,
};

const validRun: Run = {
  name: "intx-dispatch-poc",
  specPath: "spec.md",
  targetRepoPath: "/path/to/repo",
  integrationBranch: "dispatch/intx-dispatch-poc",
  baselineBuildLogPath: "dispatch/intx-dispatch-poc/baseline-build.log",
  baselineFailures: [validBuildFailure],
  commitStrategy: "per-task",
  status: "planning",
  tasks: [validTask],
  levelBoundaries: { "0": "deadbeef" },
  gateVerdicts: [],
  verificationRounds: [],
  createdAt: "2026-05-20T00:00:00Z",
};

describe("buildFailureSchema", () => {
  test("accepts a valid build failure", () => {
    expect(buildFailureSchema(validBuildFailure) instanceof type.errors).toBe(
      false,
    );
  });

  test("accepts null file and line", () => {
    const out = buildFailureSchema({
      ...validBuildFailure,
      file: null,
      line: null,
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("rejects missing id", () => {
    const { id: _id, ...rest } = validBuildFailure;
    expect(buildFailureSchema(rest) instanceof type.errors).toBe(true);
  });

  test("rejects wrong type on line", () => {
    const out = buildFailureSchema({ ...validBuildFailure, line: "42" });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("findingSchema", () => {
  test("accepts a blocking finding with line range", () => {
    expect(findingSchema(validFinding) instanceof type.errors).toBe(false);
  });

  test("accepts an advisory finding with null lineRange and filePath", () => {
    const out = findingSchema({
      id: "find-2",
      severity: "advisory",
      description: "consider extracting",
      filePath: null,
      lineRange: null,
    });
    expect(out instanceof type.errors).toBe(false);
  });

  test("rejects unknown severity", () => {
    const out = findingSchema({ ...validFinding, severity: "warning" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a single-element lineRange", () => {
    const out = findingSchema({ ...validFinding, lineRange: [10] });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("deviationSchema", () => {
  test("accepts a valid deviation", () => {
    expect(deviationSchema(validDeviation) instanceof type.errors).toBe(false);
  });

  test("rejects an unknown category", () => {
    const out = deviationSchema({ ...validDeviation, category: "speculation" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects missing affectedFiles", () => {
    const { affectedFiles: _, ...rest } = validDeviation;
    expect(deviationSchema(rest) instanceof type.errors).toBe(true);
  });
});

describe("taskOutputSchema", () => {
  test("accepts a valid task output", () => {
    expect(taskOutputSchema(validTaskOutput) instanceof type.errors).toBe(
      false,
    );
  });

  test("rejects a non-array deviations field", () => {
    const out = taskOutputSchema({ ...validTaskOutput, deviations: {} });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("critiqueVerdictSchema", () => {
  test("accepts a verdict with findings and newTests", () => {
    const verdict: CritiqueVerdict = {
      round: 1,
      status: "amend",
      findings: [validFinding],
      newTests: ["tests/new.test.ts"],
    };
    expect(critiqueVerdictSchema(verdict) instanceof type.errors).toBe(false);
  });

  test("rejects an unknown status", () => {
    const out = critiqueVerdictSchema({
      round: 1,
      status: "maybe",
      findings: [],
      newTests: [],
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("perTaskGateVerdictSchema", () => {
  test("accepts a pass with empty findings", () => {
    const out = perTaskGateVerdictSchema({ status: "pass", findings: [] });
    expect(out instanceof type.errors).toBe(false);
  });
});

describe("gateVerdictSchema", () => {
  test("accepts a valid gate verdict", () => {
    const gv: GateVerdict = {
      level: 1,
      round: 0,
      status: "pass",
      perTask: { "1a-task": { status: "pass", findings: [] } },
    };
    expect(gateVerdictSchema(gv) instanceof type.errors).toBe(false);
  });

  test("rejects perTask values with malformed shape", () => {
    const out = gateVerdictSchema({
      level: 1,
      round: 0,
      status: "pass",
      perTask: { "1a-task": { status: "pass" } },
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("verificationRoundSchema", () => {
  test("accepts a valid verification round", () => {
    const vr: VerificationRound = {
      round: 1,
      finalBuildLogPath: "dispatch/run/final-build.log",
      newFailures: [validBuildFailure],
      attribution: { "1a-task": ["bf-1"] },
      rebuildFromLevel: 1,
      outcome: "retry",
    };
    expect(verificationRoundSchema(vr) instanceof type.errors).toBe(false);
  });

  test("rejects an unknown outcome", () => {
    const out = verificationRoundSchema({
      round: 1,
      finalBuildLogPath: "x",
      newFailures: [],
      attribution: {},
      rebuildFromLevel: null,
      outcome: "winning",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("taskSchema", () => {
  test("accepts a pending task", () => {
    expect(taskSchema(validTask) instanceof type.errors).toBe(false);
  });

  test("rejects an unknown status", () => {
    const out = taskSchema({ ...validTask, status: "thinking" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects an unknown agentType", () => {
    const out = taskSchema({ ...validTask, agentType: "wizard" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a non-boolean critiqueEnabled", () => {
    const out = taskSchema({ ...validTask, critiqueEnabled: "yes" });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("runSchema", () => {
  test("accepts a minimal valid run", () => {
    expect(runSchema(validRun) instanceof type.errors).toBe(false);
  });

  test("rejects a commitStrategy other than 'per-task'", () => {
    const out = runSchema({ ...validRun, commitStrategy: "grouped" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects an unknown run status", () => {
    const out = runSchema({ ...validRun, status: "thinking" });
    expect(out instanceof type.errors).toBe(true);
  });

  test("rejects a missing required field", () => {
    const { createdAt: _, ...rest } = validRun;
    expect(runSchema(rest) instanceof type.errors).toBe(true);
  });
});
