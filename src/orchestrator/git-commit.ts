import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface GitAddAndCommitArgs {
  /** Absolute path to the git worktree the commit is created in. */
  worktreePath: string;
  /**
   * Files to stage with `git add`, relative to `worktreePath`. Must be
   * non-empty; callers that compute a zero-file commit unit are expected
   * to skip the commit entirely and record `commitSHA: null` rather than
   * forwarding an empty list here.
   */
  files: string[];
  /**
   * Full commit message, including any body. The first line is treated as
   * the summary by git tooling; this function does no further formatting.
   * Repo hooks run as normal — no `--no-verify`.
   */
  message: string;
}

/**
 * Stage `files` and create a commit in the worktree at `worktreePath`,
 * returning the new commit's full SHA.
 *
 * - Calls `git add --` followed by `git commit --message=<msg>` using
 *   `child_process.spawn`. The message is passed via argv (not a shell),
 *   so quoting edge cases (embedded quotes, backticks, dollar signs,
 *   newlines) are safe.
 * - Respects repo hooks (no `--no-verify`); a failing pre-commit hook
 *   surfaces as a thrown Error carrying the captured stderr.
 * - Rejects empty `files`: empty commit units are the caller's
 *   responsibility to recognise and skip. `--allow-empty` is never used.
 *
 * Throws on any non-zero exit. The thrown Error's `cause` carries the
 * `{ code, stderr, stdout, command }` shape so callers can log it.
 */
export async function gitAddAndCommit(
  args: GitAddAndCommitArgs,
): Promise<string> {
  const { worktreePath, files, message } = args;

  if (files.length === 0) {
    throw new Error(
      "gitAddAndCommit requires at least one file; the caller must skip zero-file commit units rather than call this with an empty list",
    );
  }

  // Filter out paths that don't actually exist in the worktree. Models
  // sometimes hallucinate file names in their `filesModified` claim
  // (e.g. claiming `src/csv.validation.test.ts` after only writing
  // `src/csv.test.ts`). Staging a non-existent path makes `git add`
  // exit non-zero with "pathspec ... did not match any files" and
  // aborts the run, so drop hallucinated claims here and proceed with
  // the real subset. The post-commit `unreportedModifications` scan
  // independently catches the inverse failure (real modifications that
  // weren't claimed).
  const existing: string[] = [];
  const missing: string[] = [];
  for (const file of files) {
    const absolute = join(worktreePath, file);
    try {
      await stat(absolute);
      existing.push(file);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `gitAddAndCommit: dropping ${String(missing.length)} hallucinated path(s) not present on disk: ${missing.join(", ")}`,
    );
  }
  if (existing.length === 0) {
    throw new Error(
      `gitAddAndCommit: every claimed path was missing from the worktree (${files.join(", ")}); nothing to commit`,
    );
  }

  await runGit(worktreePath, ["add", "--", ...existing]);
  await runGit(worktreePath, ["commit", `--message=${message}`]);
  const sha = await runGit(worktreePath, ["rev-parse", "HEAD"]);
  return sha.trim();
}

function runGit(cwd: string, gitArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(
        new Error(`failed to spawn git ${gitArgs.join(" ")}`, { cause: err }),
      );
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `git ${gitArgs.join(" ")} exited with code ${String(code)}: ${stderr.trim()}`,
          { cause: { code, stdout, stderr, command: ["git", ...gitArgs] } },
        ),
      );
    });
  });
}
