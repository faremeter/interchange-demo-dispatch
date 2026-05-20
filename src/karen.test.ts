import { describe, test, expect } from "bun:test";
import { type } from "arktype";
import {
  greybeardVerdictSchema,
  karenFinalActionSchema,
  karenInitialAction,
  karenInitialActionSchema,
  karenProcessGreybeardVerdict,
  type KarenFinalAction,
  type KarenInitialAction,
} from "./karen.js";
import type { Deviation, DeviationSeverity } from "./state/types.js";

function deviationWithSeverity(severity: DeviationSeverity): Deviation {
  return {
    id: `dev-${severity}`,
    severity,
    category: "scope",
    description: `a ${severity} deviation`,
    affectedFiles: ["src/example.ts"],
  };
}

describe("karenInitialAction", () => {
  test("minor severity maps to accept", () => {
    const action: KarenInitialAction = karenInitialAction(
      deviationWithSeverity("minor"),
    );
    expect(action).toBe("accept");
  });

  test("moderate severity maps to consultGreybeard", () => {
    const action: KarenInitialAction = karenInitialAction(
      deviationWithSeverity("moderate"),
    );
    expect(action).toBe("consultGreybeard");
  });

  test("major severity maps to escalateToOperator", () => {
    const action: KarenInitialAction = karenInitialAction(
      deviationWithSeverity("major"),
    );
    expect(action).toBe("escalateToOperator");
  });

  test("unrecognized severity throws defensively", () => {
    // Simulate an arktype-evading payload to exercise the defensive throw.
    // The static type system must be bypassed because the function signature
    // requires a Deviation, and the whole point of the test is to feed it
    // something the type system would otherwise forbid.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const callWithUnknown = karenInitialAction as (d: unknown) => KarenInitialAction;
    expect(() =>
      callWithUnknown({
        id: "dev-bogus",
        severity: "catastrophic",
        category: "scope",
        description: "out-of-band severity that bypassed arktype",
        affectedFiles: [],
      }),
    ).toThrow(/unrecognized deviation severity/);
  });
});

describe("karenProcessGreybeardVerdict", () => {
  test("accept verdict maps to accept", () => {
    const final: KarenFinalAction = karenProcessGreybeardVerdict("accept");
    expect(final).toBe("accept");
  });

  test("reject verdict maps to markFailed", () => {
    const final: KarenFinalAction = karenProcessGreybeardVerdict("reject");
    expect(final).toBe("markFailed");
  });

  test("escalate verdict maps to escalateToOperator", () => {
    const final: KarenFinalAction = karenProcessGreybeardVerdict("escalate");
    expect(final).toBe("escalateToOperator");
  });

  test("unrecognized verdict throws defensively", () => {
    // Simulate an arktype-evading payload to exercise the defensive throw.
    // See the matching comment in `karenInitialAction` tests above for why
    // the static type system must be bypassed here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const callWithUnknown = karenProcessGreybeardVerdict as (v: unknown) => KarenFinalAction;
    expect(() => callWithUnknown("ponder")).toThrow(
      /unrecognized greybeard verdict/,
    );
  });
});

describe("karen schemas", () => {
  test("karenInitialActionSchema accepts every declared action", () => {
    for (const a of [
      "accept",
      "markFailed",
      "consultGreybeard",
      "escalateToOperator",
    ] as const) {
      expect(karenInitialActionSchema(a) instanceof type.errors).toBe(false);
    }
  });

  test("karenInitialActionSchema rejects an unknown action", () => {
    expect(karenInitialActionSchema("ponder") instanceof type.errors).toBe(
      true,
    );
  });

  test("karenFinalActionSchema accepts every declared action", () => {
    for (const a of ["accept", "markFailed", "escalateToOperator"] as const) {
      expect(karenFinalActionSchema(a) instanceof type.errors).toBe(false);
    }
  });

  test("karenFinalActionSchema rejects consultGreybeard (not a final action)", () => {
    expect(
      karenFinalActionSchema("consultGreybeard") instanceof type.errors,
    ).toBe(true);
  });

  test("greybeardVerdictSchema accepts every declared verdict", () => {
    for (const v of ["accept", "reject", "escalate"] as const) {
      expect(greybeardVerdictSchema(v) instanceof type.errors).toBe(false);
    }
  });

  test("greybeardVerdictSchema rejects unknown verdicts", () => {
    expect(greybeardVerdictSchema("ponder") instanceof type.errors).toBe(true);
  });
});
