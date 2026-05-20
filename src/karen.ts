import { type } from "arktype";
import type { Deviation } from "./state/types.js";

export const karenInitialActions = [
  "accept",
  "markFailed",
  "consultGreybeard",
  "escalateToOperator",
] as const;
export type KarenInitialAction = (typeof karenInitialActions)[number];

export const karenFinalActions = [
  "accept",
  "markFailed",
  "escalateToOperator",
] as const;
export type KarenFinalAction = (typeof karenFinalActions)[number];

export const greybeardVerdicts = ["accept", "reject", "escalate"] as const;
export type GreybeardVerdict = (typeof greybeardVerdicts)[number];

export const karenInitialActionSchema = type.enumerated(...karenInitialActions);
export const karenFinalActionSchema = type.enumerated(...karenFinalActions);
export const greybeardVerdictSchema = type.enumerated(...greybeardVerdicts);

/**
 * Map a single `Deviation` to Karen's initial action. The policy is
 * hardcoded and identical in every run:
 *
 *   - `minor`    -> `accept`             (auto-accept, caller logs)
 *   - `moderate` -> `consultGreybeard`   (spawn greybeard; verdict is
 *                                          post-processed via
 *                                          `karenProcessGreybeardVerdict`)
 *   - `major`    -> `escalateToOperator` (pause run for operator input)
 *
 * Each deviation is evaluated independently; the batch decision over a
 * list of deviations is the caller's responsibility.
 */
export function karenInitialAction(deviation: Deviation): KarenInitialAction {
  switch (deviation.severity) {
    case "minor":
      return "accept";
    case "moderate":
      return "consultGreybeard";
    case "major":
      return "escalateToOperator";
    default: {
      const _exhaustive: never = deviation.severity;
      throw new Error(
        `karenInitialAction: unrecognized deviation severity: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Translate a greybeard verdict into Karen's final action after a
 * `consultGreybeard` round. The mapping is:
 *
 *   - `accept`   -> `accept`             (deviation absorbed)
 *   - `reject`   -> `markFailed`         (task fails for re-dispatch)
 *   - `escalate` -> `escalateToOperator` (operator decides)
 */
export function karenProcessGreybeardVerdict(
  verdict: GreybeardVerdict,
): KarenFinalAction {
  switch (verdict) {
    case "accept":
      return "accept";
    case "reject":
      return "markFailed";
    case "escalate":
      return "escalateToOperator";
    default: {
      const _exhaustive: never = verdict;
      throw new Error(
        `karenProcessGreybeardVerdict: unrecognized greybeard verdict: ${String(_exhaustive)}`,
      );
    }
  }
}
