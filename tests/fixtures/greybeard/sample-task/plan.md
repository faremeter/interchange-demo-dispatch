---
id: example-task
type: feature
agent: intern
---

## Objective

A small task plan used by the greybeard tests as the "plan" the
implementer was supposed to follow. The deviation under review concerns
this plan's `Constraints` section, which forbids the implementer from
adding new third-party dependencies.

## Requirements Covered

- Add a `greet()` helper to `src/greet.ts` that returns `"hello, world"`.

## Constraints

- No new third-party dependencies.

## Verification

`bun test` passes.
