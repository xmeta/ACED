# ACED Documentation Map

Status: current navigation entrypoint.

This file is the first stop for choosing which documentation set to read.
Do not treat every directory under `docs/` as equally current.
The machine-readable status and CLI applicability of each set are recorded in
`document-lifecycle.json` and validated by `npm run scwbs -- docs check`.

## Source Of Truth Order

For actual work in this repository, use this order:

1. `AGENTS.md` and the active `contracts/tasks/<task-id>.yaml`
2. `README.md` and `docs/sc-wbs-core/00-index.md`
3. Task-specific files named by the active Task Contract or work packet

If these disagree during implementation, the active Task Contract and
`AGENTS.md` win.

## Documentation Sets

| Path | Status | Use |
|---|---|---|
| `../README.md` | current | Repository overview, quick start, and top-level source-of-truth rules. |
| `../AGENTS.md` | current | Repository-specific AI operating rules. |
| `sc-wbs-core/` | current | Current SC-WBS Core concepts and target direction. |
| `scwbs/` | legacy reference | Detailed SC-WBS method and CLI references; use when current docs or a task point here. |
| `sc-wbs-core-revision/` | proposal | Draft revision notes for future Core changes; not current execution rules. |

The lifecycle vocabulary is `normative`, `informative`, `proposal`,
`deprecated`, and `superseded`. Deprecated and superseded sets must name a
successor in the manifest. Standard execution entrypoints must remain current.

## AI Reading Path

Implementation agents should read only the smallest required context:

```text
AGENTS.md
contracts/tasks/<task-id>.yaml
docs/README.md
target files named by the task
```

Use `npm run scwbs -- ai packet --task <task-id> --relation-depth 1` only
when the Task Contract does not provide enough context.

`packet --context-json` excludes proposal, deprecated, and superseded document
sets by default. Use `--context-include-noncurrent-docs` only when a task
explicitly requires historical or proposal context. This navigation filter
does not change Task Contract edit authority.

## Legacy And Proposal Boundaries

`docs/scwbs/` remains useful as a detailed reference, but it can describe
legacy or fuller SC-WBS operations that are not the first source for current
Core work.

`docs/sc-wbs-core-revision/` contains proposed changes. A proposal becomes
current only after it is covered by a Task Contract and reflected in the
current docs, implementation, Evidence, and checks.
