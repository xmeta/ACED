# Getting Started With scwbs

This guide is for a first-time user working in this repository. It focuses on
the current ACED CLI behavior, not future shorthand described in draft design
documents.

## The Mental Model

SC-WBS work has three layers:

1. **Task Contract**: what may be changed.
2. **Evidence**: what changed and which checks ran.
3. **Diff guard**: whether the branch still matches the contract.

An AI can implement within a contract, but it should not decide the contract's
scope for itself after work has started.

## First Commands

Use Node.js `>=22.12.0` and npm `>=10`. This repository pins npm `10.9.0`
through `packageManager`, so enable Corepack before installing dependencies.

Install dependencies once:

```bash
corepack enable
corepack npm install
```

Check repository health:

```bash
npm run scwbs -- check
```

Ask what needs attention:

```bash
npm run scwbs -- next
```

When in doubt, prefer `next` over guessing from Git status alone.

## Create A Small Task

For a docs-only change:

```bash
npm run scwbs -- task new "Improve user docs" --paths "README.md,docs/scwbs/getting-started.md" --stop "source change required"
```

For a code-and-test change:

```bash
npm run scwbs -- task new "Fix parser edge case" --paths "src/core/parser.ts,tests/unit/parser.test.ts" --stop "schema or dependency change required"
```

`--paths` を省略すると `allowedPaths: []` のdraftになり、実装を認可しません。`--wbs-node` を省略したTaskはWBS-lessとして保存され、WBS completion queueには入りません。Stop Conditionsを意図的に空にする場合は `--no-stop-conditions` を明示してください。

The command prints a Task Contract. Note these fields:

- `id`: pass this to later `scwbs` commands.
- `branchName`: use this exact branch name.
- `allowedPaths`: files you may change.
- `forbiddenPaths`: files you must not change.
- `humanGateRequiredPaths`: files that need human approval before change.
- `requiredChecks`: checks expected before completion.

Switch to the task branch:

```bash
git switch -c <branchName>
```

Start the task:

```bash
npm run scwbs -- task start <task-id>
```

If branch status is `mismatch`, fix the branch before editing files.

## Give Work To An AI

Give the AI this minimum context:

```text
AGENTS.md
contracts/tasks/<task-id>.yaml
```

If the AI needs more context, generate a packet:

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

For deeper context:

```bash
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
```

Do not ask the AI to read all docs unless it is changing the methodology or CLI
itself.

## Work Inside Scope

Before editing, compare the planned files with `allowedPaths`.

If the change needs a file outside `allowedPaths`, do not edit it first. Create
a new task or update the Task Contract through an explicit SC-WBS task.

If the change touches `humanGateRequiredPaths`, stop and request human
approval. Do not self-approve.

If the change requires a DB schema change, migration, authentication redesign,
permission change, breaking API change, external service decision, release
decision, or unclear business rule, block instead of guessing:

```bash
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
```

Use a more specific reason when possible.

## Finish A Task

Run the checks listed in the Task Contract. Most tasks use:

```bash
npm test
npm run typecheck
npm run build
```

Run SC-WBS checks:

```bash
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
```

Commit the implementation changes first when Evidence should describe the final
branch diff:

```bash
git add <changed-files>
git commit -m "<short description>"
```

Collect Evidence:

```bash
npm run scwbs -- evidence collect --task <task-id>
```

For docs-only work, record that no test assertions changed:

```bash
npm run scwbs -- evidence collect --task <task-id> \
  --test-assertions-added false \
  --tests-disabled false \
  --coverage-decreased false \
  --test-quality-note "Docs-only change; no test assertions changed."
```

If registry becomes stale after adding Evidence:

```bash
npm run scwbs -- registry rebuild --force
npm run scwbs -- registry rebuild --check
```

Commit Evidence and registry updates:

```bash
git add contracts/evidence/<task-id>.yaml contracts/registry.yaml
git commit -m "chore: add evidence for <task>"
```

Finally:

```bash
npm run scwbs -- check-diff --task <task-id>
```

If you commit more implementation changes after Evidence collection, regenerate
Evidence.

## Review And PR

Before opening a PR, confirm:

```bash
git status --short --branch
npm run scwbs -- check-diff --task <task-id>
```

After a PR exists, refresh Evidence with the PR number when the workflow needs
PR metadata:

```bash
npm run scwbs -- evidence collect --task <task-id> --pull-request "#123" --force
```

Do not mark Approval as approved unless a human reviewer explicitly approved it.

## Common Mistakes

| Mistake | What to do instead |
|---|---|
| Editing before reading the Task Contract | Read `contracts/tasks/<task-id>.yaml` first |
| Changing files outside `allowedPaths` | Stop and create/update a contract |
| Treating `docs/sc-wbs-core-revision/` as current rules | Treat it as draft design |
| Running several `npm run scwbs` commands in parallel | Run SC-WBS commands sequentially |
| Collecting Evidence before the final implementation commit | Commit first, then collect Evidence |
| Self-approving a Human Gate | Request human review instead |
