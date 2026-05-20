import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDispatchConfig } from "./config";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "intx-orch-config-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const validYaml = `
buildGate:
  - bun run lint
  - bun run build
  - bun run test
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;

describe("loadDispatchConfig", () => {
  test("parses a valid dispatch-config.yaml", async () => {
    const path = join(workDir, "dispatch-config.yaml");
    await writeFile(path, validYaml, "utf8");
    const config = await loadDispatchConfig(path);
    expect(config.buildGate).toEqual([
      "bun run lint",
      "bun run build",
      "bun run test",
    ]);
    expect(config.modelConfig.planner).toBe("opencode-go/kimi-k2.6");
    expect(config.modelConfig.fixAgent).toBe("opencode-go/kimi-k2.6");
  });

  test("throws on a non-existent file", async () => {
    let thrown: unknown = null;
    try {
      await loadDispatchConfig(join(workDir, "missing.yaml"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
  });

  test("throws on missing buildGate", async () => {
    const path = join(workDir, "dispatch-config.yaml");
    const yaml = `
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;
    await writeFile(path, yaml, "utf8");
    let thrown: unknown = null;
    try {
      await loadDispatchConfig(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toContain("invalid dispatch-config YAML");
    expect(thrown.cause).toBeDefined();
  });

  test("throws on empty buildGate array", async () => {
    const path = join(workDir, "dispatch-config.yaml");
    const yaml = `
buildGate: []
modelConfig:
  planner: opencode-go/kimi-k2.6
  implementer: opencode-go/kimi-k2.6
  critic: opencode-go/kimi-k2.6
  gateCritic: opencode-go/kimi-k2.6
  greybeard: opencode-go/kimi-k2.6
  attribution: opencode-go/kimi-k2.6
  fixAgent: opencode-go/kimi-k2.6
`;
    await writeFile(path, yaml, "utf8");
    let thrown: unknown = null;
    try {
      await loadDispatchConfig(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) return;
    expect(thrown.message).toContain("empty buildGate");
  });

  test("throws on missing modelConfig field", async () => {
    const path = join(workDir, "dispatch-config.yaml");
    const yaml = `
buildGate:
  - bun run build
modelConfig:
  planner: opencode-go/kimi-k2.6
`;
    await writeFile(path, yaml, "utf8");
    let thrown: unknown = null;
    try {
      await loadDispatchConfig(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test("throws on malformed YAML", async () => {
    const path = join(workDir, "dispatch-config.yaml");
    await writeFile(path, ":\n  invalid::\n  - :", "utf8");
    let thrown: unknown = null;
    try {
      await loadDispatchConfig(path);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
  });
});
