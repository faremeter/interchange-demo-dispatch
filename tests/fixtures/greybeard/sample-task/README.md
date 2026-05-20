# greybeard sample-task fixture

Used by `src/agents/greybeard.test.ts`. Layout:

- `plan.md` — the task plan the implementer was given. Sits OUTSIDE the
  worktree (deliberately) so the test exercises the path-escape additional-
  allowlist mechanism.
- `output.yaml` — the implementer's submitted output, including the
  moderate-severity deviation the greybeard is asked to rule on. Also
  outside the worktree.
- `worktree/` — the implementer's working tree. Files here are reachable
  via the standard path-escape middleware; files outside it are not, except
  for `plan.md` and `output.yaml` which the greybeard factory adds to its
  bypass allowlist. Source-shaped files in this directory carry a `.txt`
  suffix (e.g. `greet.ts.txt`) so the repo-wide ESLint project service does
  not try to parse them as TypeScript files outside the tsconfig include.

Tests copy this entire directory to a tmpdir before running so the fixture
itself is never mutated.
