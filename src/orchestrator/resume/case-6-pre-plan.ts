// Case 6 — Between baseline capture and Phase 1 start.
//
// State evidence: `run.status === "planning"` AND `run.tasks` is empty.
// `initRun` finished (baseline captured, run-state persisted) but the
// planner has not yet appended any tasks. There is no on-disk agent
// context to clean up — the planner runs out of-band of the per-task
// `tasks/` directory.
//
// Recovery: return the run untouched. The next forward pass through
// `runDispatch -> plan(...)` will re-enter planning. We persist anyway
// (via the entry point's `writeRun`) so the timestamp reflects the
// resume operation, but no semantic change happens here.

import type { Run } from "../../state/index.js";

export function detectCase6(run: Run): boolean {
  return run.status === "planning" && run.tasks.length === 0;
}

export function recoverCase6(run: Run): Run {
  // Nothing to mutate. The forward path's planner re-entry is identical to
  // the fresh-run path; case-6's only job is to discriminate this state
  // from the ambiguity bucket.
  return run;
}
