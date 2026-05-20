import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureBaseline, parseBuildFailures } from "./baseline";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-orch-baseline-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("parseBuildFailures", () => {
  test("returns no failures for a clean log", () => {
    const log = [
      "$ bun run build",
      "# cwd: /tmp/x",
      "# exit: 0",
      "src/foo.ts: ok",
      "Build succeeded",
    ].join("\n");
    expect(parseBuildFailures(log)).toEqual([]);
  });

  test("extracts file:line and message from a TS error line", () => {
    const log = [
      "$ tsc",
      "# exit: 1",
      "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
    ].join("\n");
    const failures = parseBuildFailures(log);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (!failure) throw new Error("expected failure");
    expect(failure.file).toBe("src/foo.ts");
    expect(failure.line).toBe(42);
    expect(failure.message).toContain("Cannot find name");
    expect(failure.id.startsWith("bf-")).toBe(true);
    expect(failure.rawText).toContain("src/foo.ts:42:1");
  });

  test("matches FAIL marker for test runners", () => {
    const log = [
      "$ bun test",
      "# exit: 1",
      "FAIL src/util.test.ts > does the thing",
    ].join("\n");
    const failures = parseBuildFailures(log);
    expect(failures.length).toBe(1);
  });

  test("ignores lines we emit as headers ($ / #)", () => {
    const log = [
      "$ bash -c 'echo error'",
      "# cwd: /tmp",
      "# exit: 0",
    ].join("\n");
    expect(parseBuildFailures(log)).toEqual([]);
  });

  test("strips ANSI escapes before testing for markers and location", () => {
    const log = "[31msrc/foo.ts:7:1 - error TS9999: stuff[0m";
    const failures = parseBuildFailures(log);
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (!failure) throw new Error("expected failure");
    expect(failure.file).toBe("src/foo.ts");
    expect(failure.line).toBe(7);
  });

  test("assigns stable ids: same (file, line, normalized message) -> same id", () => {
    const a = parseBuildFailures(
      "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
    );
    const b = parseBuildFailures(
      "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
    );
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    const fa = a[0];
    const fb = b[0];
    if (!fa || !fb) throw new Error("expected failures");
    expect(fa.id).toBe(fb.id);
  });

  test("distinguishes failures with different messages", () => {
    const failures = parseBuildFailures(
      [
        "src/foo.ts:42:1 - error TS2304: Cannot find name 'bar'",
        "src/bar.ts:7:1 - error TS2305: No exported member 'baz'",
      ].join("\n"),
    );
    expect(failures.length).toBe(2);
    const [f0, f1] = failures;
    if (!f0 || !f1) throw new Error("expected two failures");
    expect(f0.id).not.toBe(f1.id);
  });

  test("returns null for file/line when none can be extracted", () => {
    const failures = parseBuildFailures("FAIL: something went wrong");
    expect(failures.length).toBe(1);
    const failure = failures[0];
    if (!failure) throw new Error("expected failure");
    expect(failure.file).toBeNull();
    expect(failure.line).toBeNull();
  });
});

describe("captureBaseline", () => {
  test("runs sequential commands and writes a combined log", async () => {
    const logPath = join(workDir, "baseline-build.log");
    const result = await captureBaseline(
      workDir,
      ["echo hello", "echo world"],
      logPath,
    );
    expect(result.logPath).toBe(logPath);
    expect(result.failures).toEqual([]);
    const raw = await readFile(logPath, "utf8");
    expect(raw).toContain("$ echo hello");
    expect(raw).toContain("hello");
    expect(raw).toContain("$ echo world");
    expect(raw).toContain("world");
  });

  test("captures failures from a failing command's output", async () => {
    const logPath = join(workDir, "baseline-build.log");
    const failingCommand =
      "printf 'src/foo.ts:42:1 - error TS2304: Cannot find name bar\\n' && exit 1";
    const result = await captureBaseline(workDir, [failingCommand], logPath);
    expect(result.failures.length).toBe(1);
    const failure = result.failures[0];
    if (!failure) throw new Error("expected failure");
    expect(failure.file).toBe("src/foo.ts");
    expect(failure.line).toBe(42);
  });

  test("does not stop after a failing command", async () => {
    const logPath = join(workDir, "baseline-build.log");
    const result = await captureBaseline(
      workDir,
      ["false", "echo still-ran"],
      logPath,
    );
    const raw = await readFile(logPath, "utf8");
    expect(raw).toContain("still-ran");
    // exit codes recorded
    expect(raw).toContain("# exit: 1");
    expect(raw).toContain("# exit: 0");
    expect(result.failures).toEqual([]);
  });

  test("throws on an empty buildGate", async () => {
    let thrown: unknown = null;
    try {
      await captureBaseline(workDir, [], join(workDir, "x.log"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
