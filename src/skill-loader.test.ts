import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadSkillFiles } from "./skill-loader";

const FIXTURES_ROOT = path.resolve(
  import.meta.dir,
  "..",
  "tests",
  "fixtures",
  "skill-loader",
);

const fixturePath = (name: string) => path.join(FIXTURES_ROOT, name);

test("loadSkillFiles - repo-full includes optional files and non-dispatch skills", async () => {
  const result = await loadSkillFiles(fixturePath("repo-full"));

  const paths = result.files.map((f) => f.path);
  expect(paths).toEqual([
    "AGENTS.md",
    "CONVENTIONS.md",
    "README.md",
    path.join("skills", "a", "SKILL.md"),
    path.join("skills", "b", "SKILL.md"),
  ]);

  expect(paths).not.toContain(path.join("skills", "dispatch", "SKILL.md"));

  expect(result.missingOptional).toEqual([]);

  for (const file of result.files) {
    expect(file.bytes).toBeGreaterThan(0);
  }

  const expectedTotal = result.files.reduce((s, f) => s + f.bytes, 0);
  expect(result.totalBytes).toBe(expectedTotal);

  expect(result.blob).toContain("# === AGENTS.md ===");
  expect(result.blob).toContain("# === CONVENTIONS.md ===");
  expect(result.blob).toContain("# === README.md ===");
  expect(result.blob).toContain(
    `# === ${path.join("skills", "a", "SKILL.md")} ===`,
  );
  expect(result.blob).toContain(
    `# === ${path.join("skills", "b", "SKILL.md")} ===`,
  );
  expect(result.blob).not.toContain("dispatch skill content");
});

test("loadSkillFiles - repo-full blob is in sorted order", async () => {
  const result = await loadSkillFiles(fixturePath("repo-full"));

  const headers = result.files.map((f) => `# === ${f.path} ===`);
  let lastIdx = -1;
  for (const header of headers) {
    const idx = result.blob.indexOf(header);
    expect(idx).toBeGreaterThan(lastIdx);
    lastIdx = idx;
  }

  const sortedPaths = [...result.files.map((f) => f.path)].sort();
  expect(result.files.map((f) => f.path)).toEqual(sortedPaths);
});

test("loadSkillFiles - repo-no-skills throws when skills directory missing", async () => {
  await expect(loadSkillFiles(fixturePath("repo-no-skills"))).rejects.toThrow(
    /skills directory not found/i,
  );
});

test("loadSkillFiles - repo-empty-skills succeeds with empty skills directory", async () => {
  const result = await loadSkillFiles(fixturePath("repo-empty-skills"));

  expect(result.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
  expect(result.missingOptional).toEqual(["CONVENTIONS.md", "README.md"]);
  expect(result.blob).toContain("# === AGENTS.md ===");
});

test("loadSkillFiles - repo-skills-only succeeds with no top-level docs", async () => {
  const result = await loadSkillFiles(fixturePath("repo-skills-only"));

  expect(result.files.map((f) => f.path)).toEqual([
    path.join("skills", "a", "SKILL.md"),
  ]);
  expect(result.missingOptional).toEqual([
    "AGENTS.md",
    "CONVENTIONS.md",
    "README.md",
  ]);
  expect(result.blob).toContain(
    `# === ${path.join("skills", "a", "SKILL.md")} ===`,
  );
});

test("loadSkillFiles - paths are relative to repoRoot, never absolute", async () => {
  const root = fixturePath("repo-full");
  const result = await loadSkillFiles(root);

  for (const file of result.files) {
    expect(path.isAbsolute(file.path)).toBe(false);
    expect(file.path.startsWith(root)).toBe(false);
  }
});

test("loadSkillFiles - byte counts match the on-disk file sizes", async () => {
  const result = await loadSkillFiles(fixturePath("repo-full"));

  for (const file of result.files) {
    const abs = path.join(fixturePath("repo-full"), file.path);
    const contents = await Bun.file(abs).text();
    expect(file.bytes).toBe(Buffer.byteLength(contents, "utf8"));
  }
});

test("loadSkillFiles - throws clear error when a file exists but cannot be read", async () => {
  if (process.getuid && process.getuid() === 0) {
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "skill-loader-perm-"));
  const skillFile = path.join(tmpRoot, "skills", "x", "SKILL.md");

  let testError: unknown;
  try {
    await writeFile(path.join(tmpRoot, "AGENTS.md"), "agents\n");
    await mkdir(path.join(tmpRoot, "skills", "x"), { recursive: true });
    await writeFile(skillFile, "x skill\n");
    await chmod(skillFile, 0o000);

    await expect(loadSkillFiles(tmpRoot)).rejects.toThrow(/Failed to read/);
  } catch (err) {
    testError = err;
  }

  try {
    await chmod(skillFile, 0o644);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      err.code !== "ENOENT"
    ) {
      throw err;
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });

  if (testError !== undefined) {
    throw testError;
  }
});
