## What and why

<!-- What this changes and why. Link the issue, and the decision (D-0xx) if there is one. -->

## Checks

<!-- CONTRIBUTING.md §3 and §4. Tick what you ran; say what you didn't and why. -->

- [ ] `pnpm check` (lint, typecheck, unit tests)
- [ ] The e2e tests that cover the change: <!-- e.g. pnpm test:e2e -g "Las Vegas at 2", or pnpm test:e2e:smoke -->
- [ ] The pipeline checks, if `pipeline/` changed: `uv run ruff check . && uv run ruff format --check . && uv run pytest`
- [ ] The npm package checks, if what `pixelworld` ships changed: `pnpm package:check && pnpm package:size`

## Golden images

<!-- None changed, or each updated golden and what changed in it, after a visual review (CONTRIBUTING.md §5). -->

## Records

- [ ] A changeset (`pnpm changeset`), if what the npm package `pixelworld` ships changed
- [ ] A decision in `docs/decisions.md` (entry and index row), if this decides something
- [ ] The docs that describe what changed (roadmap, architecture, viewer reference, style guide)
