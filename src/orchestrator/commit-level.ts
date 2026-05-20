import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeRun } from "../state/index.js";
import type { Run, Task } from "../state/index.js";
import { computeAttribution, orderedTaskIds } from "./attribution.js";
import { gitAddAndCommit } from "./git-commit.js";

const COMMIT_SUMMARY_MAX = 72;

export interface CommitLevelOverrides {
  /**
   * Absolute path to the level's shared git worktree. By default
   * `commitLevel` reads `worktreePath` from each task at this level,
   * verifies they agree, and uses that value. Tests inject this directly
   * against a fixture worktree.
   */
  worktreePath?: string;
  /**
   * Absolute path to the run-state YAML file `writeRun` should persist to
   * after each commit. By default resolved as
   * `dispatch/<run.name>/run-state.yaml` relative to `process.cwd()`.
   */
  statePath?: string;
}

/**
 * Iterate the level's tasks in topological order (lexicographic tie-break on
 * task ID — see `attribution.ts`), compute shared-file attribution, and
 * create one commit per task in the level worktree.
 *
 * - Tasks with an empty attributed file list are zero-file commit units:
 *   no commit is created, `status` becomes `committed`, `commitSHA` stays
 *   `null`. Downstream phases must tolerate `null` SHAs.
 * - After each successful commit (and after each zero-file skip) the run
 *   state is persisted via `writeRun` so a crash mid-level leaves a
 *   recoverable record.
 * - `run.levelBoundaries[level+1]` is set to the post-level HEAD **after**
 *   the last commit lands, then the run is persisted again. Per spec.md
 *   §582 the order is: commit → write boundary → proceed.
 *
 * Mutates a deep-cloned copy of `run` and returns the new value; the
 * input `run` is not modified in place.
 */
export async function commitLevel(
  run: Run,
  level: number,
  overrides: CommitLevelOverrides = {},
): Promise<Run> {
  const levelTasks = run.tasks.filter((t) => t.level === level);
  if (levelTasks.length === 0) {
    throw new Error(`no tasks at level ${String(level)} in run "${run.name}"`);
  }

  const worktreePath = resolveWorktreePath(levelTasks, overrides);
  const statePath = resolveStatePath(run, overrides);

  const attribution = computeAttribution(levelTasks);
  const order = orderedTaskIds(levelTasks);

  let next = cloneRun(run);

  for (const taskId of order) {
    const taskIndex = next.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      throw new Error(`internal: task "${taskId}" vanished from run during commitLevel`);
    }
    const task = next.tasks[taskIndex];
    if (task === undefined) {
      throw new Error(`internal: task index ${String(taskIndex)} out of range`);
    }
    const files = attribution[taskId];
    if (files === undefined) {
      throw new Error(
        `internal: attribution missing entry for task "${taskId}"`,
      );
    }

    if (files.length === 0) {
      next.tasks[taskIndex] = {
        ...task,
        status: "committed",
        commitSHA: null,
      };
    } else {
      const message = buildCommitMessage(task);
      const sha = await gitAddAndCommit({ worktreePath, files, message });
      next.tasks[taskIndex] = {
        ...task,
        status: "committed",
        commitSHA: sha,
      };
    }

    await writeRun(statePath, next);
  }

  const head = await readHead(worktreePath);
  next = {
    ...next,
    levelBoundaries: { ...next.levelBoundaries, [level + 1]: head },
  };
  await writeRun(statePath, next);

  return next;
}

function resolveWorktreePath(
  tasks: Task[],
  overrides: CommitLevelOverrides,
): string {
  if (overrides.worktreePath !== undefined) {
    return overrides.worktreePath;
  }
  const paths = new Set<string>();
  for (const t of tasks) {
    if (t.worktreePath === null) {
      throw new Error(
        `task "${t.id}" has no worktreePath; runLevel must populate it before commitLevel`,
      );
    }
    paths.add(t.worktreePath);
  }
  if (paths.size !== 1) {
    throw new Error(
      `tasks at the same level must share one worktreePath; got ${String(paths.size)} distinct paths: ${[...paths].join(", ")}`,
    );
  }
  const [only] = paths;
  if (only === undefined) {
    throw new Error("internal: empty worktree path set despite size 1");
  }
  return only;
}

function resolveStatePath(run: Run, overrides: CommitLevelOverrides): string {
  if (overrides.statePath !== undefined) {
    return overrides.statePath;
  }
  return resolve(process.cwd(), "dispatch", run.name, "run-state.yaml");
}

/**
 * Build the commit message from `task.objective` per dispatch.yaml's
 * `message-source: objective` setting, formatted to match the `style`
 * skill: max 72-character summary, plain English, no prefix, no trailing
 * punctuation. If the objective contains more than one sentence the
 * first sentence is the summary and the rest becomes the body, separated
 * by a blank line.
 *
 * Summary truncation: if the first sentence exceeds 72 chars, truncate at
 * the last whitespace boundary that fits. If a single word is itself
 * longer than 72 chars (no whitespace at all), hard-cut at 72.
 */
export function buildCommitMessage(task: Task): string {
  const objective = task.objective.trim();
  if (objective.length === 0) {
    throw new Error(`task "${task.id}" has an empty objective`);
  }

  const { summary: firstSentence, rest } = splitFirstSentence(objective);
  const summary = formatSummary(firstSentence);
  const body = rest.trim();

  if (body.length === 0) return summary;
  return `${summary}\n\n${body}`;
}

function splitFirstSentence(text: string): { summary: string; rest: string } {
  const match = /^(.*?[.!?])(\s+)(.*)$/s.exec(text);
  if (match === null) return { summary: text, rest: "" };
  const [, summary, , rest] = match;
  if (summary === undefined || rest === undefined) {
    return { summary: text, rest: "" };
  }
  return { summary, rest };
}

function formatSummary(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const trimmed = oneLine.replace(/[.!?,;:]+$/, "").trim();
  if (trimmed.length <= COMMIT_SUMMARY_MAX) return trimmed;

  const slice = trimmed.slice(0, COMMIT_SUMMARY_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace <= 0) return slice;
  return slice.slice(0, lastSpace).trimEnd();
}

function cloneRun(run: Run): Run {
  return {
    ...run,
    tasks: run.tasks.map((t) => ({ ...t })),
    levelBoundaries: { ...run.levelBoundaries },
    baselineFailures: run.baselineFailures.map((f) => ({ ...f })),
    gateVerdicts: run.gateVerdicts.map((v) => ({ ...v })),
    verificationRounds: run.verificationRounds.map((v) => ({ ...v })),
  };
}

async function readHead(worktreePath: string): Promise<string> {
  return await new Promise((resolveProm, rejectProm) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) =>
      rejectProm(new Error("failed to spawn git rev-parse HEAD", { cause: e })),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolveProm(Buffer.concat(out).toString("utf8").trim());
        return;
      }
      rejectProm(
        new Error(
          `git rev-parse HEAD exited with code ${String(code)}: ${Buffer.concat(err).toString("utf8").trim()}`,
        ),
      );
    });
  });
}
