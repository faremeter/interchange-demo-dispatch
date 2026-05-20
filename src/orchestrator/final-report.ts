// Final-report writer for `runDispatch`.
//
// At the end of a run (success or terminal failure), the orchestrator
// writes a one-screen markdown summary to
// `<runDir>/report.md`. The sections match the brief's enumeration
// (spec.md §330-§356):
//
//   - Goal: the run name plus the spec path.
//   - Tasks executed: every task with its final status and commit SHA.
//   - Fix rounds: sum of `verificationFixRoundsTotal` across tasks.
//   - Critique rounds: sum of `amendmentRoundsTotal` across tasks.
//   - Commit list: each task's commit SHA (excluding zero-file units).
//   - Verification result: outcome of the last verification round
//     (or "no verification performed" when the run never reached
//     Phase 5).
//   - Total duration: `now - run.createdAt`, formatted as
//     `<hours>h<minutes>m<seconds>s` (with leading components elided
//     when zero).
//
// The persisted run-state file remains the source of truth for
// machine consumers; the markdown report is for humans skimming the
// dispatch directory.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Run, Task, VerificationRound } from "../state/index.js";

export interface WriteFinalReportOptions {
  /**
   * Absolute path to the run directory. The report is written as
   * `<runDir>/report.md`. The caller is responsible for ensuring
   * the directory is already provisioned (it normally is, because
   * `initRun` created it long before this function runs).
   */
  readonly runDir: string;
  /**
   * Optional override for "now" used when computing the run
   * duration. Tests pass a fixed timestamp; production callers
   * leave undefined and the function uses `Date.now()`.
   */
  readonly now?: Date;
}

/**
 * Render and write the run's final report. Returns the absolute
 * path the report was written to.
 */
export async function writeFinalReport(
  run: Run,
  options: WriteFinalReportOptions,
): Promise<string> {
  const runDir = resolve(options.runDir);
  await mkdir(runDir, { recursive: true });

  const reportPath = join(runDir, "report.md");
  const body = renderFinalReport(run, options.now ?? new Date());
  await writeFile(reportPath, body, "utf8");
  return reportPath;
}

/**
 * Pure rendering of the report body. Exported for tests so the
 * markdown shape is asserted directly without a filesystem round-trip.
 */
export function renderFinalReport(run: Run, now: Date): string {
  const lines: string[] = [];
  lines.push(`# Dispatch report: ${run.name}`);
  lines.push("");
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Spec: ${run.specPath}`);
  lines.push(`- Integration branch: ${run.integrationBranch}`);
  lines.push(`- Started: ${run.createdAt}`);
  lines.push(`- Duration: ${formatDuration(run.createdAt, now)}`);
  lines.push("");

  lines.push("## Tasks");
  lines.push("");
  if (run.tasks.length === 0) {
    lines.push("(no tasks materialized)");
  } else {
    for (const task of run.tasks) {
      lines.push(renderTaskBullet(task));
    }
  }
  lines.push("");

  const amendmentRounds = sumBy(run.tasks, (t) => t.amendmentRoundsTotal);
  const verificationRounds = sumBy(run.tasks, (t) => t.verificationFixRoundsTotal);
  lines.push("## Rounds");
  lines.push("");
  lines.push(`- Critique amendment rounds (sum across tasks): ${String(amendmentRounds)}`);
  lines.push(`- Verification fix rounds (sum across tasks): ${String(verificationRounds)}`);
  lines.push(`- Gate verdicts recorded: ${String(run.gateVerdicts.length)}`);
  lines.push("");

  lines.push("## Commits");
  lines.push("");
  const commitTasks = run.tasks.filter((t) => t.commitSHA !== null);
  if (commitTasks.length === 0) {
    lines.push("(no commits landed)");
  } else {
    for (const task of commitTasks) {
      lines.push(`- ${task.id}: ${task.commitSHA ?? "(zero-file unit)"}`);
    }
  }
  lines.push("");

  lines.push("## Verification");
  lines.push("");
  const lastRound = lastVerificationRound(run);
  if (lastRound === null) {
    lines.push("(no verification round was executed)");
  } else {
    lines.push(`- Last round: ${String(lastRound.round)}`);
    lines.push(`- Outcome: ${lastRound.outcome}`);
    lines.push(`- Final-build log: ${lastRound.finalBuildLogPath}`);
    lines.push(`- New failures: ${String(lastRound.newFailures.length)}`);
  }
  lines.push("");

  return lines.join("\n");
}

function renderTaskBullet(task: Task): string {
  const commit = task.commitSHA === null ? "(no commit)" : task.commitSHA;
  return `- ${task.id} [L${String(task.level)}] status=${task.status} commit=${commit}`;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function lastVerificationRound(run: Run): VerificationRound | null {
  if (run.verificationRounds.length === 0) return null;
  const last = run.verificationRounds[run.verificationRounds.length - 1];
  return last ?? null;
}

function formatDuration(startedISO: string, now: Date): string {
  const startedAt = Date.parse(startedISO);
  if (Number.isNaN(startedAt)) {
    throw new Error(`writeFinalReport: unparseable createdAt timestamp "${startedISO}"`);
  }
  const elapsedMs = Math.max(0, now.getTime() - startedAt);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (hours > 0 || minutes > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(seconds)}s`);
  return parts.join("");
}
