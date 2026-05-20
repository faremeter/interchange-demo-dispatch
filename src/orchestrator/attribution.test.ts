import { describe, test, expect } from "bun:test";
import { computeAttribution, orderedTaskIds } from "./attribution.js";
import type { Task } from "../state/index.js";

function task(id: string, filesModified: string[]): Task {
  return {
    id,
    level: 2,
    sequence: "a",
    dependsOn: [],
    objective: `objective for ${id}`,
    planMarkdown: "# plan",
    agentType: "intern",
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "submitted",
    fixingSource: null,
    worktreePath: null,
    output: {
      summary: `summary for ${id}`,
      filesModified,
      deviations: [],
      notes: "",
    },
    commitSHA: null,
    critiqueVerdicts: [],
    amendmentRoundsTotal: 0,
    verificationFixRoundsTotal: 0,
  };
}

describe("orderedTaskIds", () => {
  test("returns task IDs sorted lexicographically", () => {
    const ids = orderedTaskIds([
      task("2c-foo", []),
      task("2a-bar", []),
      task("2b-baz", []),
    ]);
    expect(ids).toEqual(["2a-bar", "2b-baz", "2c-foo"]);
  });

  test("input order is irrelevant to output", () => {
    const a = orderedTaskIds([task("z", []), task("a", []), task("m", [])]);
    const b = orderedTaskIds([task("a", []), task("m", []), task("z", [])]);
    expect(a).toEqual(b);
  });
});

describe("computeAttribution", () => {
  test("no shared files: every task owns its own files", () => {
    const tasks = [
      task("2a-foo", ["src/a.ts", "src/a.test.ts"]),
      task("2b-bar", ["src/b.ts"]),
      task("2c-baz", ["src/c.ts", "docs/c.md"]),
    ];
    const result = computeAttribution(tasks);
    expect(result).toEqual({
      "2a-foo": ["src/a.test.ts", "src/a.ts"],
      "2b-bar": ["src/b.ts"],
      "2c-baz": ["docs/c.md", "src/c.ts"],
    });
  });

  test("one shared file: later task in lex order owns it", () => {
    const tasks = [
      task("2a-early", ["src/shared.ts", "src/early-only.ts"]),
      task("2b-late", ["src/shared.ts", "src/late-only.ts"]),
    ];
    const result = computeAttribution(tasks);
    expect(result["2a-early"]).toEqual(["src/early-only.ts"]);
    expect(result["2b-late"]).toEqual(["src/late-only.ts", "src/shared.ts"]);
  });

  test("multiple shared files across pairs of tasks", () => {
    const tasks = [
      task("2a", ["src/a.ts", "src/ab.ts", "src/ac.ts"]),
      task("2b", ["src/ab.ts", "src/bc.ts"]),
      task("2c", ["src/ac.ts", "src/bc.ts", "src/c.ts"]),
    ];
    const result = computeAttribution(tasks);
    expect(result["2a"]).toEqual(["src/a.ts"]);
    expect(result["2b"]).toEqual(["src/ab.ts"]);
    expect(result["2c"]).toEqual(["src/ac.ts", "src/bc.ts", "src/c.ts"]);
  });

  test("all-shared: the lex-last task owns every file", () => {
    const tasks = [
      task("2a", ["src/x.ts", "src/y.ts"]),
      task("2b", ["src/x.ts", "src/y.ts"]),
      task("2c", ["src/x.ts", "src/y.ts"]),
    ];
    const result = computeAttribution(tasks);
    expect(result["2a"]).toEqual([]);
    expect(result["2b"]).toEqual([]);
    expect(result["2c"]).toEqual(["src/x.ts", "src/y.ts"]);
  });

  test("input order does not change the result", () => {
    const a = computeAttribution([
      task("2a", ["src/shared.ts"]),
      task("2b", ["src/shared.ts", "src/b.ts"]),
    ]);
    const b = computeAttribution([
      task("2b", ["src/shared.ts", "src/b.ts"]),
      task("2a", ["src/shared.ts"]),
    ]);
    expect(a).toEqual(b);
  });

  test("zero-files task is preserved with an empty owned list", () => {
    const tasks = [
      task("2a-explore", []),
      task("2b-feature", ["src/feature.ts"]),
    ];
    const result = computeAttribution(tasks);
    expect(result["2a-explore"]).toEqual([]);
    expect(result["2b-feature"]).toEqual(["src/feature.ts"]);
  });

  test("duplicate file entries within one task collapse cleanly", () => {
    const tasks = [task("2a", ["src/dup.ts", "src/dup.ts", "src/other.ts"])];
    const result = computeAttribution(tasks);
    expect(result["2a"]).toEqual(["src/dup.ts", "src/other.ts"]);
  });

  test("throws when a task at the level has no output", () => {
    const t = task("2a", []);
    const broken: Task = { ...t, output: null };
    expect(() => computeAttribution([broken])).toThrow(/no output/);
  });
});
