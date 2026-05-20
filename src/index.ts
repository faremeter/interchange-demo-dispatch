// Public barrel.
//
// The PoC's external surface is intentionally minimal: a single
// `runDispatch` function plus the two types callers need to construct
// the `SpecRef` input and inspect the resulting `Run`. Every other
// export (helpers, schemas, gate / commit / verify primitives) lives
// behind `./orchestrator/index.js` and is considered an implementation
// detail that may move between PoC iterations.

export { runDispatch } from "./orchestrator/index.js";
export type { Run, SpecRef } from "./orchestrator/index.js";
