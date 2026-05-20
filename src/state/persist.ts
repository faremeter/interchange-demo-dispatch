import { type } from "arktype";
import { open, rename, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { runSchema } from "./schema.js";
import type { Run } from "./types.js";

/**
 * Atomically write `run` to `path` as YAML. The write goes to a sibling
 * tmp file, is fsync'd, then renamed over the destination. A crash mid-write
 * leaves the destination either untouched (if it existed) or absent (if it
 * didn't); it never leaves a partial document at `path`.
 */
export async function writeRun(path: string, run: Run): Promise<void> {
  const absolute = resolve(path);
  const dir = dirname(absolute);
  const tmpPath = `${absolute}.tmp-${process.pid}-${Date.now()}`;

  const yaml = stringifyYAML(run);

  const handle = await open(tmpPath, "wx");
  try {
    await handle.writeFile(yaml, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, absolute);

  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/**
 * Read the YAML document at `path`, parse it, and validate against `runSchema`.
 * Throws an `Error` (with the arktype errors object attached as `cause`) if
 * the file is missing, unparseable, or fails validation. Never returns
 * partially-valid state.
 */
export async function loadRun(path: string): Promise<Run> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf8");

  const parsed: unknown = parseYAML(raw);
  const validated = runSchema(parsed);

  if (validated instanceof type.errors) {
    throw new Error(
      `invalid run-state YAML at ${absolute}: ${validated.summary}`,
      { cause: validated },
    );
  }

  return validated satisfies Run;
}
