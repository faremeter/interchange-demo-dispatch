# Hello-world smoke spec

This is the Definition-of-Success smoke spec for `interchange-demo-dispatch`. The
orchestrator drives the three tasks below against
`examples/fixtures/sample-target/`, the small TypeScript project that
ships with this repo for end-to-end testing.

## Goal

Extend the sample target so it can greet a named recipient and
expose that greeting from its top-level entry point. The change is
deliberately small but exercises every piece of the orchestrator:
parallel tasks at level 1, a level-2 task that depends on both, a
critique step, a level gate, per-task commits at fan-in, and a final
Phase 5 verification against the baseline build.

## Tasks

### Task 1: add `greet(name: string)` to `src/greet.ts`

Add a new module `src/greet.ts` that exports `greet(name)`, returning
`` `Hello, ${name}!` ``. Add a test in `src/greet.test.ts` covering
both a typical name and an empty string (empty string must still
produce `Hello, !` so the function has no hidden branches). No edits
to existing files.

- Level: 1
- Depends on: nothing
- Files: `src/greet.ts`, `src/greet.test.ts`

### Task 2: add `formatHello(name: string)` to `src/format.ts`

Add a sibling module `src/format.ts` that exports `formatHello(name)`,
returning the upper-cased greeting (`HELLO, <NAME>!`). Add a test in
`src/format.test.ts`. This task runs in parallel with Task 1 — no
shared files.

- Level: 1
- Depends on: nothing
- Files: `src/format.ts`, `src/format.test.ts`

### Task 3: wire both helpers from `src/index.ts` and update `README.md`

Edit `src/index.ts` so it re-exports both `greet` and `formatHello`
alongside the existing `hello()` function. Update `README.md` to
mention the two new helpers in the "Scripts" section's preamble.

- Level: 2
- Depends on: Task 1, Task 2
- Files: `src/index.ts`, `README.md`

## Verification

`bun run lint`, `bun run build`, and `bun run test` (the
`buildGate` declared in `dispatch-config.yaml`) must all exit zero on
the resulting state and produce the same output the baseline captured
after Task 0. The orchestrator's Phase 5 engine performs that
comparison automatically.
