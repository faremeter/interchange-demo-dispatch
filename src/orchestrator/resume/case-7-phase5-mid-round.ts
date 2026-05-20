// Case 7 — Mid-Phase-5 fix loop, between verificationRounds entries.
//
// State evidence: a `final-build.log-<N>` exists under `<runDir>/` for an
// N greater than `run.verificationRounds.length`. Phase 5 writes the
// final build log BEFORE appending the round to state (spec.md §670-§673
// + see `phase5/index.ts` where `writeFile(finalLogPath, ...)` precedes
// `appendVerificationRound(...)`). A crash between those two ops leaves
// an orphan log.
//
// Recovery:
//
//   1. Delete every orphan `final-build.log-<N>` whose N is greater than
//      `verificationRounds.length`. The next forward pass through Phase 5
//      will write a fresh log for the next round and attribute it from
//      scratch — the spec accepts the wasted-LLM cost here.
//   2. The persisted state is otherwise consistent: `verificationRounds`
//      records every completed round. We don't touch `Run.status`; the
//      forward path's normal entry (status `fixing-verification` or
//      `verifying`) handles re-entry.
//
// "Restart attribution" in the spec means we re-run the attribution agent
// on the new log; deleting the orphan ensures it's not double-counted.
// The phrase "attach to the next round" in the brief is a misreading of
// the spec — the orphan log corresponds to a round whose attribution
// never completed; the safe move is to discard it and rebuild fresh, not
// fold its contents into a different round's evidence pool.

import { join } from "node:path";

import type { Run } from "../../state/index.js";
import { readDirOrEmpty, type ResumeFsHooks } from "../resume.js";

const FINAL_LOG_PREFIX = "final-build.log-";

export async function detectCase7Logs(
  run: Run,
  runDir: string,
): Promise<string[]> {
  const orphans = await findOrphanLogs(run, runDir);
  return orphans.map((o) => o.name);
}

export async function recoverCase7(
  run: Run,
  runDir: string,
  _evidence: readonly string[],
  hooks: ResumeFsHooks,
): Promise<Run> {
  const orphans = await findOrphanLogs(run, runDir);
  for (const orphan of orphans) {
    await hooks.runRemove(join(runDir, orphan.name));
  }
  return run;
}

interface OrphanLog {
  readonly name: string;
  readonly round: number;
}

async function findOrphanLogs(run: Run, runDir: string): Promise<OrphanLog[]> {
  const entries = await readDirOrEmpty(runDir);
  const orphans: OrphanLog[] = [];
  const persistedRounds = run.verificationRounds.length;
  for (const entry of entries) {
    if (!entry.startsWith(FINAL_LOG_PREFIX)) continue;
    const suffix = entry.slice(FINAL_LOG_PREFIX.length);
    const round = Number.parseInt(suffix, 10);
    if (Number.isNaN(round)) continue;
    if (String(round) !== suffix) continue;
    if (round > persistedRounds) {
      orphans.push({ name: entry, round });
    }
  }
  orphans.sort((a, b) => a.round - b.round);
  return orphans;
}
