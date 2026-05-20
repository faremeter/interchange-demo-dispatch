import { describe, expect, test } from "bun:test";

import { validateDAG, type ProposedTask } from "./dag-validate";

function task(
  id: string,
  level: number,
  dependsOn: string[] = [],
): ProposedTask {
  return { id, level, dependsOn };
}

describe("validateDAG", () => {
  test("empty input is valid with no levels", () => {
    const result = validateDAG([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.levels).toEqual({});
    }
  });

  test("single leaf at level 1", () => {
    const result = validateDAG([task("a", 1)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.levels).toEqual({ a: 1 });
    }
  });

  test("linear chain levels compute correctly", () => {
    const result = validateDAG([
      task("a", 1),
      task("b", 2, ["a"]),
      task("c", 3, ["b"]),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.levels).toEqual({ a: 1, b: 2, c: 3 });
    }
  });

  test("diamond DAG levels compute as 1 + max(deps)", () => {
    // a (1) -> b (2), c (2) -> d (3)
    const result = validateDAG([
      task("a", 1),
      task("b", 2, ["a"]),
      task("c", 2, ["a"]),
      task("d", 3, ["b", "c"]),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.levels).toEqual({ a: 1, b: 2, c: 2, d: 3 });
    }
  });

  test("declared level inconsistent with deps is rejected", () => {
    // c declares level 2 but depends on b (which sits at level 2),
    // so its actual level is 3.
    const result = validateDAG([
      task("a", 1),
      task("b", 2, ["a"]),
      task("c", 2, ["b"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.issues.join("\n");
      expect(joined).toMatch(/"c"/);
      expect(joined).toMatch(/declared level 2/);
      expect(joined).toMatch(/imply level 3/);
    }
  });

  test("leaf declared at level 2 is rejected", () => {
    const result = validateDAG([task("a", 2)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toMatch(/declared level 2.*imply level 1/);
    }
  });

  test("non-positive level is rejected", () => {
    const result = validateDAG([task("a", 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toMatch(/invalid level/);
    }
  });

  test("dangling dependency is rejected", () => {
    const result = validateDAG([task("a", 1), task("b", 2, ["ghost"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.issues.join("\n");
      expect(joined).toMatch(/"b"/);
      expect(joined).toMatch(/"ghost"/);
      expect(joined).toMatch(/unknown task id/);
    }
  });

  test("self-dependency is rejected", () => {
    const result = validateDAG([task("a", 1, ["a"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toMatch(/depends on itself/);
    }
  });

  test("duplicate ids are rejected and reported once per id", () => {
    const result = validateDAG([task("a", 1), task("a", 1), task("a", 1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const duplicateIssues = result.issues.filter((i) =>
        i.includes("duplicate task id"),
      );
      expect(duplicateIssues).toEqual(['duplicate task id "a"']);
    }
  });

  test("duplicate dependency entries are rejected", () => {
    const result = validateDAG([task("a", 1), task("b", 2, ["a", "a"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toMatch(/dependency "a" more than once/);
    }
  });

  test("two-node cycle is detected", () => {
    const result = validateDAG([
      task("a", 1, ["b"]),
      task("b", 1, ["a"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleIssues = result.issues.filter((i) => i.startsWith("cycle"));
      expect(cycleIssues.length).toBe(1);
      expect(cycleIssues[0]).toMatch(/cycle detected/);
    }
  });

  test("three-node cycle is detected once", () => {
    const result = validateDAG([
      task("a", 1, ["b"]),
      task("b", 1, ["c"]),
      task("c", 1, ["a"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleIssues = result.issues.filter((i) => i.startsWith("cycle"));
      expect(cycleIssues.length).toBe(1);
    }
  });

  test("returns every issue at once, not just the first", () => {
    // Two unrelated structural problems should both surface so the planner
    // does not have to round-trip the runtime to discover the second.
    const result = validateDAG([
      task("a", 1),
      task("a", 1), // duplicate
      task("b", 2, ["ghost"]), // dangling
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("duplicate task id"))).toBe(
        true,
      );
      expect(result.issues.some((i) => i.includes("unknown task id"))).toBe(
        true,
      );
    }
  });

  test("structural errors short-circuit level computation", () => {
    // A dangling dep on its own should not produce a level-mismatch issue;
    // the dangling-dep issue is enough to send the planner back.
    const result = validateDAG([task("a", 1, ["ghost"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const levelIssues = result.issues.filter((i) => i.includes("imply level"));
      expect(levelIssues).toEqual([]);
    }
  });

  test("cycle detection short-circuits level computation", () => {
    const result = validateDAG([
      task("a", 1, ["b"]),
      task("b", 1, ["a"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const levelIssues = result.issues.filter((i) => i.includes("imply level"));
      expect(levelIssues).toEqual([]);
    }
  });

  test("level matches max-of-deps + 1 when multiple deps land at different levels", () => {
    // a (1), b (2, deps=a), c (3, deps=b), d (4, deps=a, c) — d's level is
    // 1 + max(1, 3) = 4.
    const result = validateDAG([
      task("a", 1),
      task("b", 2, ["a"]),
      task("c", 3, ["b"]),
      task("d", 4, ["a", "c"]),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.levels.d).toBe(4);
    }
  });
});
