# critic fixtures

Used by `src/agents/critic.test.ts` and `src/agents/gate-critic.test.ts`.
Tests copy the relevant subdirectory to a tmpdir before running so they
never mutate the fixture itself.

- `clean-task/` — a worktree the implementer "completed" successfully.
  The critic should produce a `pass` verdict with no findings.
- `buggy-task/` — a worktree with an obvious defect in the touched code.
  The critic should produce an `amend` verdict with at least one blocking
  finding.

The source files use a `.ts.txt` suffix so the workspace eslint /
typescript project service does not try to type-check them as part of
the dispatch codebase. The critic reads them byte-for-byte regardless
of extension.
