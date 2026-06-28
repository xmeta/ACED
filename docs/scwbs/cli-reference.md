# scwbs CLI Reference

This file is the detailed command index. Keep `README.md` short and link here when command examples grow.

Run through the npm script:

```bash
npm run scwbs -- --help
```

## Core Checks

```bash
npm run scwbs -- init --profile lean --agent codex --lang ja
npm run scwbs -- check
npm run scwbs -- doctor
npm run scwbs -- health
npm run scwbs -- check-diff --task WBS-001-004
npm run scwbs -- status
```

## AI Workflow

```bash
npm run scwbs -- ai packet --task WBS-001-004 --relation-depth 1
npm run scwbs -- ai run --task WBS-001-004 --agent codex
npm run scwbs -- ai block --task WBS-001-004 --reason "Human Gate required"
npm run scwbs -- ai next-task
npm run scwbs -- next
```

`ai run` is initially a dry-run orchestrator. It prints the pre-flight checks, implementation stop conditions, and post-flight checks rather than launching an external agent.

## Contracts

```bash
npm run scwbs -- task generate --node node-api --task WBS-001-004
npm run scwbs -- task lock --task WBS-001-004
npm run scwbs -- task refresh --task WBS-001-004
npm run scwbs -- evidence collect --task WBS-001-004
npm run scwbs -- registry rebuild --check
npm run scwbs -- profile show
npm run scwbs -- profile set lean
```

Generated contract commands must refuse to overwrite existing files unless an explicit `--force` option is documented and supplied.

## Review And Approval

```bash
npm run scwbs -- review-queue
npm run scwbs -- review route --task WBS-001-004
npm run scwbs -- review request --task WBS-001-004 --pull-request "#42"
npm run scwbs -- approval request --task WBS-001-004 --pull-request "#42" --note "Awaiting human review"
```

`review-queue` prints tasks that are likely waiting on human review next, distinguishes nodes ready for review from nodes still blocked by unfinished dependencies, surfaces branch and PR metadata, shows approval status from `contracts/approvals/*.yaml`, warns when review metadata is missing, adds a `suggestedAction` per candidate, and includes a compact review-health summary.

`review route` previews requested reviewer roles from Evidence changed files. `review request` records those roles in `contracts/reviews/<task-id>.yaml` as `requestedReviewers`.

Approval records live under `contracts/approvals/*.yaml` and can carry human-review metadata independently from Evidence:

```yaml
id: APR-SCWBS-006
type: approval
taskId: SCWBS-006
status: requested
pullRequest: "#42"
notes:
  - Awaiting human gate review
```

`approval request` creates a `requested` record without fabricating human approval. `--note` is available both as a quoted multi-word argument and as inline syntax such as `--note=Awaiting human review`.

## Lightweight Entry Points

```bash
npm run scwbs -- start "natural language goal"
npm run scwbs -- plan --spec SPEC-001
npm run scwbs -- lite task "small change title"
npm run scwbs -- promote --task WBS-001-004
```

These commands generate drafts or candidates. They do not directly rewrite the canonical WBS.

## Trace And UI

```bash
npm run scwbs -- trace --task WBS-001-004
npm run scwbs -- ui
npm run scwbs -- serve
```

`ui` is a text dashboard. `serve` is intentionally a stub until a dependency change passes Human Gate.

## WBS

```bash
npm run scwbs -- wbs validate
npm run scwbs -- wbs apply change-set.json
```

WBS operation details and validation commands are documented in `docs/scwbs/wjs-operations-validation.md`.

## Build Output

After building:

```bash
npm run build
node dist/cli.js --help
```
