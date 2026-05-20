import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type SkillFile = {
  path: string;
  bytes: number;
};

export type SkillFileBlob = {
  blob: string;
  files: SkillFile[];
  totalBytes: number;
  missingOptional: string[];
};

const OPTIONAL_TOP_LEVEL = ["AGENTS.md", "CONVENTIONS.md", "README.md"] as const;
const EXCLUDED_SKILL = "dispatch";

const isErrnoException = (
  err: unknown,
): err is NodeJS.ErrnoException =>
  err instanceof Error && "code" in err && typeof err.code === "string";

const readOptional = async (
  repoRoot: string,
  relPath: string,
): Promise<{ relPath: string; contents: string } | null> => {
  const absPath = join(repoRoot, relPath);
  try {
    const contents = await readFile(absPath, "utf8");
    return { relPath, contents };
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read ${relPath} at ${absPath}`, { cause: err });
  }
};

const discoverSkillFiles = async (repoRoot: string): Promise<string[]> => {
  const skillsDir = join(repoRoot, "skills");

  let dirStat;
  try {
    dirStat = await stat(skillsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new Error(
        `Required skills directory not found at ${skillsDir}`,
        { cause: err },
      );
    }
    throw new Error(`Failed to stat skills directory at ${skillsDir}`, {
      cause: err,
    });
  }

  if (!dirStat.isDirectory()) {
    throw new Error(`Expected directory at ${skillsDir} but found non-directory`);
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillRelPaths: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === EXCLUDED_SKILL) continue;

    const skillMdAbs = join(skillsDir, entry.name, "SKILL.md");
    try {
      const s = await stat(skillMdAbs);
      if (!s.isFile()) continue;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") continue;
      throw new Error(`Failed to stat ${skillMdAbs}`, { cause: err });
    }

    skillRelPaths.push(join("skills", entry.name, "SKILL.md"));
  }

  return skillRelPaths;
};

export const loadSkillFiles = async (
  repoRoot: string,
): Promise<SkillFileBlob> => {
  const missingOptional: string[] = [];
  const loaded: { relPath: string; contents: string }[] = [];

  for (const relPath of OPTIONAL_TOP_LEVEL) {
    const result = await readOptional(repoRoot, relPath);
    if (result === null) {
      missingOptional.push(relPath);
    } else {
      loaded.push(result);
    }
  }

  const skillRelPaths = await discoverSkillFiles(repoRoot);

  for (const relPath of skillRelPaths) {
    const absPath = join(repoRoot, relPath);
    let contents: string;
    try {
      contents = await readFile(absPath, "utf8");
    } catch (err) {
      throw new Error(`Failed to read skill file ${relPath} at ${absPath}`, {
        cause: err,
      });
    }
    loaded.push({ relPath, contents });
  }

  loaded.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const files: SkillFile[] = [];
  const parts: string[] = [];

  for (const { relPath, contents } of loaded) {
    const bytes = Buffer.byteLength(contents, "utf8");
    files.push({ path: relPath, bytes });
    parts.push(`# === ${relPath} ===\n${contents}`);
  }

  const blob = parts.join("\n");
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

  return { blob, files, totalBytes, missingOptional };
};
