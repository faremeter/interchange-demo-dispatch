import { describe, expect, test } from "bun:test";

import { normalizeBuildOutput, sameOutput } from "./normalize.js";

const WORKTREE = "/Users/runner/workspace/run-1";

describe("normalizeBuildOutput", () => {
  test("strips standard SGR ANSI escapes", () => {
    const colored = "\x1b[31mFAIL\x1b[0m a test";
    expect(normalizeBuildOutput(colored, { worktreePath: WORKTREE })).toBe(
      "FAIL a test",
    );
  });

  test("strips CSI escape envelopes", () => {
    const csi = "\x1b[2K\x1b[1Aready";
    expect(normalizeBuildOutput(csi, { worktreePath: WORKTREE })).toBe("ready");
  });

  test("collapses ISO-8601 timestamps with timezone", () => {
    const out = normalizeBuildOutput(
      "started at 2024-05-20T10:11:12.345Z and again at 2024-05-20T10:11:13+02:00",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("started at <TIMESTAMP> and again at <TIMESTAMP>");
  });

  test("collapses bracketed clock timestamps", () => {
    const out = normalizeBuildOutput(
      "[10:11:12] starting [10:11:13.456] done",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("[<TIMESTAMP>] starting [<TIMESTAMP>] done");
  });

  test("rewrites absolute worktree paths to <WORKTREE>", () => {
    const out = normalizeBuildOutput(
      `failed at ${WORKTREE}/src/foo.ts:42`,
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("failed at <WORKTREE>/src/foo.ts:42");
  });

  test("rewrites trailing-slash worktree paths to <WORKTREE>", () => {
    const out = normalizeBuildOutput(
      `failed at ${WORKTREE}/src/foo.ts:42`,
      { worktreePath: `${WORKTREE}/` },
    );
    expect(out).toBe("failed at <WORKTREE>/src/foo.ts:42");
  });

  test("collapses Time: 123ms style measurements", () => {
    const out = normalizeBuildOutput(
      "Time: 123ms\nTime: 1.234s\nTime: 7m",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("Time: <TIME>\nTime: <TIME>\nTime: <TIME>");
  });

  test("collapses parenthesized runtime measurements", () => {
    const out = normalizeBuildOutput(
      "ran 5 tests (12ms)\nran 6 tests (3.4s)",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("ran 5 tests (<TIME>)\nran 6 tests (<TIME>)");
  });

  test("collapses elapsed/duration phrases", () => {
    const out = normalizeBuildOutput(
      "took 42ms\nelapsed: 1.5s\nfinished in 200ms",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("elapsed <TIME>\nelapsed <TIME>\nelapsed <TIME>");
  });

  test("collapses re-run / retry suffixes", () => {
    const out = normalizeBuildOutput(
      "spec/foo.ts:42 (re-run #3) and bar.ts (retry 2)",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe(
      "spec/foo.ts:42 (<RUN>) and bar.ts (<RUN>)",
    );
  });

  test("collapses hex addresses and pids", () => {
    const out = normalizeBuildOutput(
      "panic at 0xdeadbeef pid=12345",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("panic at <ADDR> pid=<PID>");
  });

  test("collapses macOS-style tmp folders", () => {
    const out = normalizeBuildOutput(
      "wrote /var/folders/xy/zz/T/scratch.xyz",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("wrote <TMP>");
  });

  test("collapses /tmp paths", () => {
    const out = normalizeBuildOutput(
      "log at /tmp/run-7/output.log",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("log at <TMP>");
  });

  test("uses extraPathPrefixes placeholders", () => {
    const out = normalizeBuildOutput(
      "see /repo/target/build.log",
      { worktreePath: WORKTREE, extraPathPrefixes: ["/repo/target"] },
    );
    expect(out).toBe("see <TARGET>/build.log");
  });

  test("trims trailing whitespace per line", () => {
    const out = normalizeBuildOutput(
      "line one   \nline two\t\t\nline three",
      { worktreePath: WORKTREE },
    );
    expect(out).toBe("line one\nline two\nline three");
  });
});

describe("sameOutput", () => {
  test("treats two coloured / timestamped outputs as equal when their normalized forms match", () => {
    const a = "\x1b[31mFAIL\x1b[0m at 2024-05-20T10:11:12Z (12ms)";
    const b = "FAIL at 2024-05-21T08:09:10Z (40ms)";
    expect(sameOutput(a, b, { worktreePath: WORKTREE })).toBe(true);
  });

  test("preserves real differences", () => {
    const a = "FAIL test/foo.ts unexpected token";
    const b = "FAIL test/bar.ts unexpected token";
    expect(sameOutput(a, b, { worktreePath: WORKTREE })).toBe(false);
  });

  test("baseline-vs-final scenarios share normalized form when only path differs", () => {
    const a = "compilation error in /Users/runner/workspace/run-1/src/index.ts";
    const b = "compilation error in /Users/runner/workspace/run-2/src/index.ts";
    expect(
      sameOutput(a, b, { worktreePath: "/Users/runner/workspace/run-1" }),
    ).toBe(false);
    expect(
      sameOutput(a, b, {
        worktreePath: "/Users/runner/workspace/run-1",
        extraPathPrefixes: ["/Users/runner/workspace/run-2"],
      }),
    ).toBe(false);
  });
});
