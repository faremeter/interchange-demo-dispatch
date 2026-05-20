// Bookkeeping helpers for `Run.verificationRounds`.
//
// Phase 5 appends a fresh `VerificationRound` entry at the start of
// every fix-loop iteration and finalizes it once the round's outcome
// (`pass` / `retry` / `escalated`) is known. The helpers below own
// the immutable updates so the main engine stays focused on policy.

import type {
  BuildFailure,
  Run,
  VerificationOutcome,
  VerificationRound,
} from "../../state/index.js";

export interface AppendVerificationRoundArgs {
  readonly run: Run;
  readonly finalBuildLogPath: string;
  readonly newFailures: readonly BuildFailure[];
  readonly attribution: Record<string, string[]>;
  readonly rebuildFromLevel: number | null;
  readonly outcome: VerificationOutcome;
}

/**
 * Append a fresh `VerificationRound` to the run, returning a new
 * `Run`. The `round` field is derived from the existing array length:
 * the first round is `1`. Rounds are append-only; the engine never
 * mutates a round it previously wrote.
 */
export function appendVerificationRound(args: AppendVerificationRoundArgs): Run {
  const round: VerificationRound = {
    round: args.run.verificationRounds.length + 1,
    finalBuildLogPath: args.finalBuildLogPath,
    newFailures: args.newFailures.map((f) => ({ ...f })),
    attribution: cloneAttribution(args.attribution),
    rebuildFromLevel: args.rebuildFromLevel,
    outcome: args.outcome,
  };
  return {
    ...args.run,
    verificationRounds: [...args.run.verificationRounds, round],
  };
}

/**
 * Replace the most recent `VerificationRound` with a new value. Used
 * when the engine wants to revise a round's outcome (e.g. from
 * `retry` to `escalated`) without appending a new entry.
 */
export function replaceLatestVerificationRound(
  run: Run,
  next: VerificationRound,
): Run {
  if (run.verificationRounds.length === 0) {
    throw new Error(
      "replaceLatestVerificationRound: run has no verification rounds yet",
    );
  }
  const idx = run.verificationRounds.length - 1;
  const existing = run.verificationRounds[idx];
  if (existing === undefined) {
    throw new Error(
      "replaceLatestVerificationRound: latest verification round is undefined",
    );
  }
  if (existing.round !== next.round) {
    throw new Error(
      `replaceLatestVerificationRound: refusing to overwrite round ${String(existing.round)} with round ${String(next.round)}`,
    );
  }
  const rounds = [...run.verificationRounds];
  rounds[idx] = next;
  return { ...run, verificationRounds: rounds };
}

function cloneAttribution(attr: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(attr)) {
    next[k] = [...v];
  }
  return next;
}

/**
 * Find the earliest (lowest-numbered) level among the tasks the
 * attribution agent named. Used by step 5 to decide where the
 * rebuild starts. Returns `null` if no attribution names a task at
 * any level — the engine treats that as a bug.
 */
export function earliestAffectedLevel(
  run: Run,
  attribution: Record<string, string[]>,
): number | null {
  const taskById = new Map(run.tasks.map((t) => [t.id, t]));
  let earliest: number | null = null;
  for (const ids of Object.values(attribution)) {
    for (const id of ids) {
      const t = taskById.get(id);
      if (t === undefined) {
        throw new Error(
          `earliestAffectedLevel: attribution references unknown task "${id}"`,
        );
      }
      if (earliest === null || t.level < earliest) {
        earliest = t.level;
      }
    }
  }
  return earliest;
}

/**
 * Collect the unique task ids named by an attribution map. The ids
 * are returned in lexicographic order to match `orderedTaskIds`'s
 * convention.
 */
export function attributedTaskIds(
  attribution: Record<string, string[]>,
): string[] {
  const seen = new Set<string>();
  for (const ids of Object.values(attribution)) {
    for (const id of ids) seen.add(id);
  }
  return Array.from(seen).sort();
}
