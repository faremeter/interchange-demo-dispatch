import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { terminalTool } from "./terminal-tool";

const SubmitSchema = type({
  result: "string",
  count: "number",
});

function makeCall(args: Record<string, unknown>, id = "call-1") {
  return { id, name: "submit", arguments: args };
}

function asFullHandler(tool: ReturnType<typeof terminalTool>["tool"]) {
  if (tool.kind !== "full") {
    throw new Error(
      `expected terminalTool to produce a full-handler AgentTool, got kind=${tool.kind}`,
    );
  }
  return tool.handler;
}

describe("terminalTool", () => {
  test("validation success resolves the Promise with the validated value", async () => {
    const term = terminalTool("submit", SubmitSchema);
    const handler = asFullHandler(term.tool);
    const ac = new AbortController();

    const result = await handler(
      makeCall({ result: "done", count: 7 }),
      ac.signal,
    );

    expect(result.callId).toBe("call-1");
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();

    const value = await term.awaitTermination();
    expect(value).toEqual({ result: "done", count: 7 });
  });

  test("validation failure returns isError and does not resolve the Promise", async () => {
    const term = terminalTool("submit", SubmitSchema);
    const handler = asFullHandler(term.tool);
    const ac = new AbortController();

    const result = await handler(
      makeCall({ result: "done", count: "not-a-number" }),
      ac.signal,
    );

    expect(result.isError).toBe(true);
    expect(result.callId).toBe("call-1");
    expect(typeof result.content).toBe("string");

    // The Promise must not be resolved on validation failure. We race it
    // against a short timer; the timer should win.
    const sentinel = Symbol("pending");
    const winner = await Promise.race([
      term.awaitTermination(),
      new Promise<typeof sentinel>((resolve) =>
        setTimeout(() => {
          resolve(sentinel);
        }, 20),
      ),
    ]);
    expect(winner).toBe(sentinel);
  });

  test("re-invocation after a successful resolution does not double-resolve", async () => {
    const term = terminalTool("submit", SubmitSchema);
    const handler = asFullHandler(term.tool);
    const ac = new AbortController();

    const first = await handler(
      makeCall({ result: "first", count: 1 }, "call-1"),
      ac.signal,
    );
    expect(first.isError).toBeUndefined();
    expect(first.content).toBe("ok");

    const firstValue = await term.awaitTermination();
    expect(firstValue).toEqual({ result: "first", count: 1 });

    const second = await handler(
      makeCall({ result: "second", count: 2 }, "call-2"),
      ac.signal,
    );
    expect(second.isError).toBe(true);
    expect(second.callId).toBe("call-2");
    expect(typeof second.content).toBe("string");

    // The Promise stays resolved with the first value — JS Promises cannot
    // re-resolve, and a second await must yield the same payload.
    const stillFirst = await term.awaitTermination();
    expect(stillFirst).toEqual({ result: "first", count: 1 });
  });

  test("definition.name matches the caller and inputSchema is derived from the arktype schema", () => {
    const term = terminalTool("submit", SubmitSchema);
    expect(term.tool.definition.name).toBe("submit");

    const expected = SubmitSchema.toJsonSchema();
    expect(term.tool.definition.inputSchema).toEqual({ ...expected });
  });

  test("the validated type flows through the Promise without casts", async () => {
    const term = terminalTool("submit", SubmitSchema);
    const handler = asFullHandler(term.tool);
    const ac = new AbortController();

    await handler(makeCall({ result: "typed", count: 3 }), ac.signal);
    const value = await term.awaitTermination();

    // If the generic did not flow, these property accesses would not
    // type-check — the test compiling is itself part of the assertion.
    const upper: string = value.result.toUpperCase();
    const doubled: number = value.count * 2;
    expect(upper).toBe("TYPED");
    expect(doubled).toBe(6);
  });
});
