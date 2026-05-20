// Greybeard tool argument schemas.
//
// `recordGreybeardVerdict` is the greybeard agent's single terminal tool. It
// carries the verdict (one of `accept` / `reject` / `escalate`) together with
// the `taskId` / `deviationId` the verdict pertains to and a non-empty
// rationale. The schema is the runtime boundary the model talks to; the
// orchestrator (5b-run-level) consumes the validated payload via
// `awaitVerdict` and feeds the `verdict` field to
// `karenProcessGreybeardVerdict`.

import { type } from "arktype";

import { greybeardVerdicts } from "../karen.js";

const greybeardVerdictEnumSchema = type.enumerated(...greybeardVerdicts);

/**
 * Arktype schema for a single `recordGreybeardVerdict` invocation. Mirrors
 * the plan's contract: `taskId`, `deviationId`, `verdict`, and a non-empty
 * `rationale`. The non-empty constraint on `rationale` is enforced by the
 * schema so a model that submits an empty string sees `isError: true` and
 * can retry without ever resolving the terminal Promise.
 */
export const greybeardVerdictPayloadSchema = type({
  taskId: "string > 0",
  deviationId: "string > 0",
  verdict: greybeardVerdictEnumSchema,
  rationale: "string > 0",
});

export type GreybeardVerdictPayload = typeof greybeardVerdictPayloadSchema.infer;
