# Hello-world dispatch fixture

A small free-form spec used by the planner's integration test to verify a
three-task DAG can be produced. The planner should turn this into:

  - `bootstrap` — scaffold the project skeleton (level 1)
  - `feature` — add the hello-world feature on top of the scaffold (level 2)
  - `smoke-test` — exercise the feature end-to-end (level 3)

The shape of the produced DAG is the assertion. The body of each task's
`planMarkdown` is up to the planner; the runtime only enforces the minimum
length and the structural rules.

## Constraints

- Tasks must declare their level consistently with their dependencies.
- The `smoke-test` task must depend on the `feature` task, which in turn
  depends on `bootstrap`.
