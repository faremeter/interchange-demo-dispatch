import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeMiddleware } from "@intx/tools-posix";
import type { ToolHandler, Middleware } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { createPathEscapeMiddleware } from "./path-escape";

let root: string;
let outsideDir: string;

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/**
 * A passthrough base handler that records what it received and returns a
 * success result. Letting calls reach this handler means the middleware
 * allowed them through.
 */
function makeBase(): {
  handler: ToolHandler;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  const handler: ToolHandler = async (call) => {
    calls.push(call);
    return { callId: call.id, content: "ok" };
  };
  return { handler, calls };
}

function run(
  middleware: Middleware,
  base: ToolHandler,
  call: ToolCall,
): Promise<ToolResult> {
  const composed = composeMiddleware([middleware], base);
  return composed(call, neverAbort());
}

beforeAll(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "path-escape-root-")));
  outsideDir = realpathSync(await mkdtemp(join(tmpdir(), "path-escape-out-")));

  await writeFile(join(root, "inside.txt"), "hello");
  await writeFile(join(outsideDir, "secret.txt"), "nope");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("createPathEscapeMiddleware: allowed paths", () => {
  test("absolute path inside root passes through for every path-bearing tool", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const inside = join(root, "inside.txt");

    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "grep",
      "search_files",
    ]) {
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: `t-${name}`,
        name,
        arguments: { path: inside },
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.arguments.path).toBe(inside);
    }
  });

  test("relative path resolving inside root passes through", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "rel",
      name: "read_file",
      arguments: { path: "inside.txt" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  test("missing optional path argument is allowed (grep/search_files)", async () => {
    const mw = createPathEscapeMiddleware({ root });
    for (const name of ["grep", "search_files"]) {
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: `opt-${name}`,
        name,
        arguments: { pattern: "x" },
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
    }
  });

  test("tool-output URIs on read_file are not treated as filesystem paths", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "blob",
      name: "read_file",
      arguments: { path: "tool-output:///abc123" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  test("non-existent target under root is allowed (write_file new file)", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "new",
      name: "write_file",
      arguments: {
        path: join(root, "nested", "deeper", "newfile.txt"),
        content: "x",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  test("run_shell with no cwd argument passes through (cwd injected by host)", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "shell",
      name: "run_shell",
      arguments: { command: "echo hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  test("run_shell with cwd inside root passes through", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "shell-cwd",
      name: "run_shell",
      arguments: { command: "echo hi", cwd: root },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });
});

describe("createPathEscapeMiddleware: direct escapes", () => {
  test("rejects '../' relative traversal for every path-bearing tool", async () => {
    const mw = createPathEscapeMiddleware({ root });
    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "grep",
      "search_files",
    ]) {
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: `up-${name}`,
        name,
        arguments: { path: "../../etc/passwd", content: "" },
      });
      expect(result.isError).toBe(true);
      expect(typeof result.content).toBe("string");
      expect(result.content).toContain("outside the configured root");
      expect(result.content).toContain(root);
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects absolute path outside root", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "abs",
      name: "read_file",
      arguments: { path: "/etc/passwd" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("/etc/passwd");
    expect(calls).toHaveLength(0);
  });

  test("rejects absolute path in sibling tmpdir", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const target = join(outsideDir, "secret.txt");
    const result = await run(mw, handler, {
      id: "sibling",
      name: "read_file",
      arguments: { path: target },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(target);
    expect(calls).toHaveLength(0);
  });

  test("rejects deeply nested traversal that lands outside root", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const traversal = join(root, "a", "b", "..", "..", "..", "etc", "passwd");
    const result = await run(mw, handler, {
      id: "deep",
      name: "edit_file",
      arguments: {
        path: traversal,
        old_string: "x",
        new_string: "y",
      },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("guards against prefix-only string match (sibling root with shared prefix)", async () => {
    const sibling = realpathSync(
      await mkdtemp(join(tmpdir(), "path-escape-root-sibling-")),
    );
    try {
      // `sibling` shares a tmpdir parent with `root` but is a distinct dir.
      // A naive `startsWith(root)` check would mis-classify it as inside
      // if its name happened to share root's prefix.
      const mw = createPathEscapeMiddleware({ root });
      const { handler, calls } = makeBase();
      const target = join(sibling, "x.txt");
      await writeFile(target, "x");
      const result = await run(mw, handler, {
        id: "prefix",
        name: "read_file",
        arguments: { path: target },
      });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });
});

describe("createPathEscapeMiddleware: symlink escapes", () => {
  test("rejects symlink under root that points outside root", async () => {
    const linkName = "escape-link";
    const linkPath = join(root, linkName);
    await symlink(outsideDir, linkPath);

    try {
      const mw = createPathEscapeMiddleware({ root });
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: "sym",
        name: "read_file",
        arguments: { path: join(linkPath, "secret.txt") },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("outside the configured root");
      expect(calls).toHaveLength(0);
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  test("rejects write through a symlinked directory pointing outside", async () => {
    const linkPath = join(root, "write-escape-link");
    await symlink(outsideDir, linkPath);

    try {
      const mw = createPathEscapeMiddleware({ root });
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: "sym-write",
        name: "write_file",
        arguments: {
          path: join(linkPath, "new-file.txt"),
          content: "x",
        },
      });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  test("rejects run_shell cwd that resolves outside the root via symlink", async () => {
    const linkPath = join(root, "cwd-escape");
    await symlink(outsideDir, linkPath);

    try {
      const mw = createPathEscapeMiddleware({ root });
      const { handler, calls } = makeBase();
      const result = await run(mw, handler, {
        id: "sym-cwd",
        name: "run_shell",
        arguments: { command: "pwd", cwd: linkPath },
      });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});

describe("createPathEscapeMiddleware: run_shell cwd", () => {
  test("rejects run_shell cwd outside root", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "cwd-out",
      name: "run_shell",
      arguments: { command: "ls", cwd: outsideDir },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(outsideDir);
    expect(calls).toHaveLength(0);
  });

  test("rejects run_shell cwd that is '../'", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "cwd-up",
      name: "run_shell",
      arguments: { command: "ls", cwd: ".." },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("createPathEscapeMiddleware: composition", () => {
  test("composes with other middlewares without disturbing them", async () => {
    const inside = join(root, "inside.txt");
    const observed: string[] = [];

    const taggingMiddleware: Middleware =
      (next: ToolHandler): ToolHandler =>
      async (call, signal) => {
        observed.push(`before:${call.name}`);
        const result = await next(call, signal);
        observed.push(`after:${call.name}`);
        return result;
      };

    const pathEscape = createPathEscapeMiddleware({ root });
    const { handler } = makeBase();

    // Sandwich: tagging -> pathEscape -> tagging -> base. The middleware
    // under test must not interfere with neighbours when the call is safe.
    const composed = composeMiddleware(
      [taggingMiddleware, pathEscape, taggingMiddleware],
      handler,
    );

    const result = await composed(
      {
        id: "compose-ok",
        name: "read_file",
        arguments: { path: inside },
      },
      neverAbort(),
    );

    expect(result.isError).toBeFalsy();
    expect(observed).toEqual([
      "before:read_file",
      "before:read_file",
      "after:read_file",
      "after:read_file",
    ]);
  });

  test("rejection short-circuits inner middlewares and the base handler", async () => {
    const inner: string[] = [];

    const innerMiddleware: Middleware =
      (next: ToolHandler): ToolHandler =>
      async (call, signal) => {
        inner.push(call.id);
        return next(call, signal);
      };

    const pathEscape = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const composed = composeMiddleware([pathEscape, innerMiddleware], handler);

    const result = await composed(
      {
        id: "compose-bad",
        name: "read_file",
        arguments: { path: "/etc/passwd" },
      },
      neverAbort(),
    );

    expect(result.isError).toBe(true);
    expect(inner).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("passes through tools with no path arguments unchanged", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "no-path",
      name: "some_other_tool",
      arguments: { foo: "bar", count: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({ foo: "bar", count: 3 });
  });
});

describe("createPathEscapeMiddleware: error shape", () => {
  test("returns ToolResult with isError true and mentions both path and root", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler } = makeBase();
    const result = await run(mw, handler, {
      id: "shape",
      name: "read_file",
      arguments: { path: "/etc/passwd" },
    });
    expect(result.callId).toBe("shape");
    expect(result.isError).toBe(true);
    if (typeof result.content !== "string") {
      throw new Error("expected string content");
    }
    expect(result.content).toContain("/etc/passwd");
    expect(result.content).toContain(root);
  });

  test("does not throw — errors flow through as ToolResult", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler } = makeBase();
    // Spy by wrapping run() in a try/catch; if anything throws, the test
    // will fail because Bun reports uncaught rejections.
    const result = await run(mw, handler, {
      id: "noThrow",
      name: "write_file",
      arguments: { path: "/var/log/wherever", content: "x" },
    });
    expect(result.isError).toBe(true);
  });

  test("rejects non-string path argument with a clear message", async () => {
    const mw = createPathEscapeMiddleware({ root });
    const { handler, calls } = makeBase();
    const result = await run(mw, handler, {
      id: "bad-type",
      name: "read_file",
      arguments: { path: 42 },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("must be a string");
    expect(calls).toHaveLength(0);
  });
});

describe("createPathEscapeMiddleware: construction", () => {
  test("throws when root is not absolute", () => {
    expect(() => createPathEscapeMiddleware({ root: "relative/dir" })).toThrow(
      "must be absolute",
    );
  });

  test("throws when root does not exist", () => {
    expect(() =>
      createPathEscapeMiddleware({ root: "/nonexistent/path/xyz" }),
    ).toThrow();
  });
});
