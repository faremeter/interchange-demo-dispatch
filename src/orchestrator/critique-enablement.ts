// Critique enablement rule.
//
// spec.md §449-§450 defines which tasks are subject to critique:
//   - `general` agents are ALWAYS critiqued.
//   - `intern` agents are critiqued by default; an explicit per-task
//     override turns critique off.
//   - `explore` agents are NEVER critiqued.
//
// This pure predicate is the single source of truth for the rule and is
// consumed by `gate(...)` to choose which tasks fan out to the per-task
// critic.

import type { Task } from "../state/index.js";

export function isCritiqueEnabled(task: Task): boolean {
  switch (task.agentType) {
    case "general":
      return true;
    case "explore":
      return false;
    case "intern":
      return task.critiqueEnabled;
  }
}
