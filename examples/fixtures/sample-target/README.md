# intx-dispatch sample target

A minimal bun TypeScript project used as the fixture for the
intx-dispatch smoke test (see `examples/smoke-test.ts`).

Out of the box it exposes a single `hello()` function and a passing
test. The smoke spec at `examples/hello-world-spec.md` describes a
three-task change against this project; running the orchestrator
against the smoke spec exercises the full forward path end-to-end.

## Scripts

- `bun run lint` — eslint over `src/`.
- `bun run build` — TypeScript build (`tsc -b`).
- `bun run test` — bun test runner.

The trio above is what the dispatch-config.yaml registers as
`buildGate`. The smoke test asserts they all exit 0 on the baseline
state and that, after the orchestrator drives the three-task change
to completion, the final build still exits 0 and matches the
baseline output.
