import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Middleware, ToolHandler } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

function isENOENT(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === "ENOENT";
}

/**
 * Tool argument keys that carry filesystem paths, indexed by tool name.
 * `run_shell` accepts an optional `cwd`; even though the upstream tool
 * definition does not currently expose it to the model, defending in depth
 * costs nothing and protects against future changes to the surface.
 */
const PATH_ARGS: Record<string, readonly string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  grep: ["path"],
  search_files: ["path"],
  run_shell: ["cwd"],
};

const TOOL_OUTPUT_URI_PREFIX = "tool-output:";

export interface PathEscapeOptions {
  /**
   * Absolute path to the directory implementer tool calls are confined to.
   * Resolved via `realpath` once at construction time; symlinks under this
   * directory are evaluated against the resolved root, not the link target.
   */
  root: string;
}

/**
 * Resolve a path against the configured root and verify the result remains
 * inside the root. Symlinks are followed by walking from the deepest existing
 * ancestor up the chain and applying `realpath` there, then re-attaching the
 * unresolved tail. This catches symlinks under the root that point outward
 * (e.g. `<root>/escape -> /etc`), since their realpath lands outside the
 * resolved root.
 *
 * Returns `null` when the path is safe, or an error message describing the
 * escape when it is not.
 */
function checkPath(raw: string, resolvedRoot: string): string | null {
  const candidate = isAbsolute(raw) ? raw : resolve(resolvedRoot, raw);

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (err) {
    if (!isENOENT(err)) throw err;
    // The leaf (or some ancestor) does not exist yet — typical for
    // write_file on a fresh target. Walk up until we hit a real path,
    // resolve that, then re-attach the missing tail. This still catches
    // symlinks earlier in the chain that escape the root.
    resolved = resolveBestEffort(candidate);
  }

  const rel = relative(resolvedRoot, resolved);
  if (rel === "") return null;
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return `path "${raw}" resolves to "${resolved}", which is outside the configured root "${resolvedRoot}"`;
  }
  return null;
}

function resolveBestEffort(absPath: string): string {
  let current = absPath;
  const tail: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch (err) {
      if (!isENOENT(err)) throw err;
      const parent = resolve(current, "..");
      if (parent === current) {
        // Hit the filesystem root without finding anything real; fall back
        // to the lexical resolution. This branch is unreachable in
        // practice because `/` always exists.
        return absPath;
      }
      const idx = current.lastIndexOf(sep);
      tail.push(current.slice(idx + 1));
      current = parent;
    }
  }
}

function rejection(callId: string, message: string): ToolResult {
  return { callId, content: message, isError: true };
}

export function createPathEscapeMiddleware(
  opts: PathEscapeOptions,
): Middleware {
  if (!isAbsolute(opts.root)) {
    throw new Error(`path-escape root must be absolute: ${opts.root}`);
  }
  const resolvedRoot = realpathSync(opts.root);

  return (next: ToolHandler): ToolHandler => {
    return async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const argKeys = PATH_ARGS[call.name];
      if (argKeys !== undefined) {
        for (const key of argKeys) {
          const value = call.arguments[key];
          if (value === undefined) continue;
          if (typeof value !== "string") {
            return rejection(
              call.id,
              `argument "${key}" for tool "${call.name}" must be a string when present`,
            );
          }
          if (
            call.name === "read_file" &&
            key === "path" &&
            value.startsWith(TOOL_OUTPUT_URI_PREFIX)
          ) {
            continue;
          }
          const err = checkPath(value, resolvedRoot);
          if (err !== null) return rejection(call.id, err);
        }
      }
      return next(call, signal);
    };
  };
}
