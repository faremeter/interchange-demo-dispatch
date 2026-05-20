import { describe, expect, test } from "bun:test";

import type { AgentType, Task } from "../state/index.js";

import { isCritiqueEnabled } from "./critique-enablement.js";

function makeTask(over: Partial<Task> & { agentType: AgentType }): Task {
  const base: Task = {
    id: "t",
    level: 0,
    sequence: "a",
    dependsOn: [],
    objective: "",
    planMarkdown: "",
    agentType: over.agentType,
    class: "feature",
    critiqueEnabled: true,
    verifyCommands: [],
    status: "pending",
    fixingSource: null,
    worktreePath: null,
    output: null,
    commitSHA: null,
    critiqueVerdicts: [],
    amendmentRoundsTotal: 0,
    verificationFixRoundsTotal: 0,
  };
  return { ...base, ...over };
}

describe("isCritiqueEnabled", () => {
  test("general agents are always critiqued regardless of the flag", () => {
    expect(isCritiqueEnabled(makeTask({ agentType: "general" }))).toBe(true);
    expect(
      isCritiqueEnabled(
        makeTask({ agentType: "general", critiqueEnabled: false }),
      ),
    ).toBe(true);
  });

  test("explore agents are never critiqued", () => {
    expect(isCritiqueEnabled(makeTask({ agentType: "explore" }))).toBe(false);
    expect(
      isCritiqueEnabled(
        makeTask({ agentType: "explore", critiqueEnabled: true }),
      ),
    ).toBe(false);
  });

  test("intern agents follow the flag (on by default in the PoC)", () => {
    expect(
      isCritiqueEnabled(
        makeTask({ agentType: "intern", critiqueEnabled: true }),
      ),
    ).toBe(true);
    expect(
      isCritiqueEnabled(
        makeTask({ agentType: "intern", critiqueEnabled: false }),
      ),
    ).toBe(false);
  });
});
