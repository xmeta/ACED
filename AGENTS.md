# AGENTS.md

## Project

This repository contains `scwbs`, a TypeScript CLI for SC-WBS Development.
The canonical methodology is documented in `docs/sc-wbs-development.md`.
The WBS-JSON implementation lives in the `wjs/` submodule.

## Working Rules

* Do not make implementation changes outside an assigned Task Contract unless the user explicitly asks for them.
* Treat `contracts/wbs/project.wbs.json` as the WBS source of truth.
* Treat `contracts/tasks/*.yaml` as the allowed work scope for AI implementation.
* Respect `allowedPaths`, `forbiddenPaths`, and `humanGateRequiredPaths`.
* If a change needs Human Gate approval, stop implementation and use `scwbs ai block` to propose a blocked WBS change set.
* Do not mark a WBS node `completed`; completion is a human decision after Evidence and review are present.
* Do not revert user changes or unrelated local changes.

## Development

Install dependencies:

```bash
npm install
```

Run validation:

```bash
npm test
npm run typecheck
npm run build
```

Run the CLI during development:

```bash
npm run scwbs -- --help
```

## Useful Commands

```bash
npm run scwbs -- check
npm run scwbs -- health
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
npm run scwbs -- ai next-task
```

## Code Style

* Keep the CLI small and dependency-light.
* Prefer existing helpers under `src/core/` before adding new utilities.
* Keep command modules focused and test behavior through `tests/scwbs.test.ts`.
* Use ASCII in source files unless existing content or user-facing Japanese documentation requires otherwise.
