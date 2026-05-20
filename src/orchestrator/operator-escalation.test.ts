// Tests for `awaitOperatorResolution`.
//
// The function polls a YAML file inside the run directory and resolves once
// the operator (or an `operatorResolver` test stub) writes `continue` or
// `abort` into the `resolution` field. Tests drive both resolutions and the
// timeout path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type } from "arktype";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";

import {
  awaitOperatorResolution,
  OperatorEscalationTimeoutError,
  PENDING_ESCALATION_FILENAME,
} from "./operator-escalation.js";

// Arktype morph that parses YAML and validates the persisted
// pending-escalation.yaml shape in one step. The thunk around `parseYAML`
// pins it to the single-arg signature arktype's `Morph` requires.
const pendingEscalation = type("string").pipe(
  (raw: string) => parseYAML(raw),
  type({
    reason: "string",
    details: "Record<string, unknown>",
    resolution: "string",
  }),
);

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "intx-operator-test-"));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  throw new Error(`file ${path} never appeared`);
}

describe("awaitOperatorResolution", () => {
  test("resolves with 'continue' when the operator writes continue", async () => {
    const escalationPath = join(runDir, PENDING_ESCALATION_FILENAME);
    const promise = awaitOperatorResolution({
      runDir,
      reason: "test continue",
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    await waitForFile(escalationPath);

    const raw = await readFile(escalationPath, "utf8");
    const parsed = pendingEscalation.assert(raw);
    const next = { ...parsed, resolution: "continue" };
    await writeFile(escalationPath, stringifyYAML(next), "utf8");

    const result = await promise;
    expect(result).toBe("continue");
    // The function cleans up the escalation file after resolving.
    let stillThere = true;
    try {
      await stat(escalationPath);
    } catch {
      stillThere = false;
    }
    expect(stillThere).toBe(false);
  });

  test("resolves with 'abort' when the operator writes abort", async () => {
    const escalationPath = join(runDir, PENDING_ESCALATION_FILENAME);
    const promise = awaitOperatorResolution({
      runDir,
      reason: "test abort",
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    await waitForFile(escalationPath);

    const raw = await readFile(escalationPath, "utf8");
    const parsed = pendingEscalation.assert(raw);
    const next = { ...parsed, resolution: "abort" };
    await writeFile(escalationPath, stringifyYAML(next), "utf8");

    const result = await promise;
    expect(result).toBe("abort");
  });

  test("throws OperatorEscalationTimeoutError when the deadline passes", async () => {
    const start = Date.now();
    await expect(
      awaitOperatorResolution({
        runDir,
        reason: "test timeout",
        pollIntervalMs: 5,
        timeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(OperatorEscalationTimeoutError);
    // Sanity: the timeout actually waited some time, not instant.
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  test("ignores unrecognized resolution values and keeps polling", async () => {
    const escalationPath = join(runDir, PENDING_ESCALATION_FILENAME);
    const promise = awaitOperatorResolution({
      runDir,
      reason: "test invalid",
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    await waitForFile(escalationPath);

    // First, write an unrecognized value; the polling loop should ignore it.
    const raw = await readFile(escalationPath, "utf8");
    const parsed = pendingEscalation.assert(raw);
    const bad = { ...parsed, resolution: "maybe later" };
    await writeFile(escalationPath, stringifyYAML(bad), "utf8");
    await new Promise((r) => setTimeout(r, 30));

    // Then write a real value; the loop should pick it up.
    const good = { ...parsed, resolution: "continue" };
    await writeFile(escalationPath, stringifyYAML(good), "utf8");

    const result = await promise;
    expect(result).toBe("continue");
  });

  test("escalation file embeds the reason and structured details", async () => {
    const escalationPath = join(runDir, PENDING_ESCALATION_FILENAME);
    const promise = awaitOperatorResolution({
      runDir,
      reason: "moderate deviation requires escalation",
      details: { taskId: "t1", deviationId: "d1", severity: "major" },
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    await waitForFile(escalationPath);

    const raw = await readFile(escalationPath, "utf8");
    const parsed = pendingEscalation.assert(raw);
    expect(parsed.reason).toBe("moderate deviation requires escalation");
    expect(parsed.details).toEqual({
      taskId: "t1",
      deviationId: "d1",
      severity: "major",
    });

    const next = { ...parsed, resolution: "continue" };
    await writeFile(escalationPath, stringifyYAML(next), "utf8");
    await promise;
  });
});
