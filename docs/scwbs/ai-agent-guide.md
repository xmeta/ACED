# AI Agent Guide

This guide tells AI agents how to use `scwbs` without loading unnecessary
methodology context or confusing draft specs with current rules.

## Priority Order

When instructions conflict, use this order:

1. `AGENTS.md`
2. The active `contracts/tasks/<task-id>.yaml`
3. The packet generated for that task
4. Current command docs under `docs/scwbs/`
5. Core reference docs under `docs/sc-wbs-core/`
6. Draft revision docs under `docs/sc-wbs-core-revision/`

Do not treat `docs/sc-wbs-core-revision/` as current behavior unless a Task
Contract explicitly asks you to implement or integrate that draft.

## Implementation AI Checklist

Before editing:

1. Read `AGENTS.md`.
2. Read `contracts/tasks/<task-id>.yaml`.
3. Confirm current branch equals `branchName`.
4. List the files you expect to modify.
5. Check those files against `allowedPaths`, `forbiddenPaths`, and
   `humanGateRequiredPaths`.

Useful command:

```bash
npm run scwbs -- start <task-id>
```

If more task context is needed:

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

or:

```bash
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
```

Do not read the whole docs tree by default.

## Stop Conditions

Stop implementation and block when the work requires any of the following:

- files outside `allowedPaths`
- files under `forbiddenPaths`
- unapproved `humanGateRequiredPaths`
- DB schema or migration changes
- authentication or permission changes
- breaking API changes
- unclear business rules
- personal data or security setting changes
- external service, billing, release, or deployment decisions
- spec-level judgment that is not already contracted

Block command:

```bash
npm run scwbs -- ai block --task <task-id> --reason "<reason>"
```

Do not continue by making a best-effort assumption.

## Completion Checklist

A task is not Done because the implementation looks complete. It is Done only
after required checks, Evidence, and diff validation are complete.

Typical sequence:

```bash
npm test
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
git status --short --branch
```

Commit the implementation changes, then collect Evidence:

```bash
npm run scwbs -- evidence collect --task <task-id>
```

If Evidence or registry files are added after the implementation commit, commit
those metadata files separately.

Final gate:

```bash
npm run scwbs -- check-diff --task <task-id>
```

If any commit changes the subject diff after Evidence collection, regenerate
Evidence.

## Review AI Checklist

Do not review from the implementer's summary alone. Ground Truth is:

- Task Contract
- packet
- Spec Slice / acceptance criteria, when present
- actual branch diff
- Evidence
- Approval scope

Review questions:

- Does every changed file fit the Task Contract?
- Did the implementation touch `forbiddenPaths`?
- Did it need Human Gate approval?
- Does Evidence describe the final subject commit and changed files?
- Did required checks pass?
- Are tests appropriate for the risk of the change?
- Did the branch add metadata without updating registry?

If the answer is unclear, do not approve. Use `changes_requested` or
`needs_human_decision`.

## Commands To Prefer

```bash
npm run scwbs -- next
npm run scwbs -- start <task-id>
npm run scwbs -- packet --task <task-id> --tiny
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- review-queue
```

Run SC-WBS commands sequentially. They build the TypeScript output before
running and can interfere with each other if run in parallel.

## What Not To Do

- Do not use `git diff` alone to decide task validity.
- Do not edit YAML/JSON contract files by hand unless the Task Contract allows
  contract or registry updates.
- Do not mark Approval as `approved`.
- Do not complete WBS nodes directly.
- Do not edit `contracts/wbs/project.wbs.json` directly. The canonical WBS is
  updated only through a changeset under `contracts/changesets/` applied with
  `npm run scwbs -- wbs apply contracts/changesets/<file> --force --output contracts/wbs/project.wbs.json`.
  `scwbs check` and `scwbs check-diff` fail with `wbs.changeset.required` when
  the WBS is edited without a corresponding changeset.
- Do not use future Core shorthand from draft docs when the current CLI docs
  specify a different command.
- Do not ignore `review-queue` just because `next` suggests a planned task.

