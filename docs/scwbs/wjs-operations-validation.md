# WJS Operations And Validation

This repository treats `wjs/` as the canonical WBS-JSON implementation.

## Source Of Truth

The WBS source of truth is:

```text
contracts/wbs/project.wbs.json
```

This file follows:

```text
wjs/schema/wbs-json.schema.json
```

## Change-Set Rule

WBS changes must be proposed as semantic operation change sets under:

```text
contracts/changesets/*.json
```

Do not hand-edit or regenerate the whole WBS when a small semantic operation is enough. Use `wjs/schema/wbs-operations.schema.json` operations such as `addNode` and `addRelation`.

## Validate The WBS

```bash
npm --prefix wjs run validate -- ../contracts/wbs/project.wbs.json
npm run scwbs -- wbs validate
```

`scwbs wbs validate` and `scwbs check` use `wjs/tools/validate.ts --wbs` internally.

## Validate Operations

```bash
npm --prefix wjs run validate -- --operations ../contracts/changesets/change-set.json
```

`scwbs check-diff` validates `contracts/changesets/*.json` with `wjs/tools/validate.ts --operations`.

## Diff Enforcement

`scwbs check-diff --task <task-id>` enforces these WBS-related rules:

- If `contracts/wbs/project.wbs.json` changes, at least one `contracts/changesets/*.json` file must be present in the diff.
- `contracts/changesets/*.json` files must pass the WJS operations schema.
- The current Git branch must match the Task Contract `branchName`.
- The WBS node must not be marked `completed` by AI implementation work.

## Apply Preview

Use dry-run change sets for preview and review:

```json
{
  "version": "1.0",
  "changeSetId": "example-change",
  "reason": "Add implementation task",
  "dryRun": true,
  "operations": []
}
```

Only write to `contracts/wbs/project.wbs.json` after Human Gate approval:

```bash
npm run scwbs -- wbs apply contracts/changesets/change-set.json --force --output contracts/wbs/project.wbs.json
```
