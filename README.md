# scwbs

`scwbs` is a CLI for operating **SC-WBS Development**:

> AI-Collaborative Spec Contract and WBS Driven Development

It uses the bundled `wjs` submodule as the canonical WBS-JSON implementation and adds SC-WBS-specific checks around Task Contracts, Evidence, Human Gates, AI work packets, and Git diffs.

## What This Project Contains

```text
.
├── src/                     # scwbs CLI source
│   ├── cli.ts
│   ├── commands/
│   └── core/
├── tests/                   # Vitest coverage for the MVP CLI
├── contracts/               # SC-WBS contracts for this repository
├── docs/
│   └── sc-wbs-development.md # SC-WBS methodology document
├── wjs/                     # WBS-JSON submodule
├── package.json
└── tsconfig.json
```

## Core Idea

`scwbs` does not define its own WBS format.

The WBS source of truth is:

```text
contracts/wbs/project.wbs.json
```

That file follows `wjs/schema/wbs-json.schema.json`.

SC-WBS-specific implementation contracts live beside it:

```text
contracts/
├── registry.yaml
├── wbs/
│   └── project.wbs.json
├── tasks/
│   └── WBS-001-004.yaml
├── evidence/
│   └── WBS-001-004.yaml
└── approvals/
```

This repository dogfoods SC-WBS. The active project WBS is:

```text
contracts/wbs/project.wbs.json
```

Current and planned repository work is represented by:

```text
contracts/tasks/*.yaml
```

## Commands

Run through the npm script:

```bash
npm run scwbs -- --help
```

Available commands:

```bash
npm run scwbs -- init
npm run scwbs -- check
npm run scwbs -- health
npm run scwbs -- check-diff --task WBS-001-004
npm run scwbs -- check-diff --task SCWBS-001
npm run scwbs -- ai packet --task WBS-001-004 --relation-depth 1
npm run scwbs -- ai block --task WBS-001-004 --reason "Human Gate required"
npm run scwbs -- ai next-task
npm run scwbs -- task generate --node node-api --task WBS-001-004
npm run scwbs -- task lock --task WBS-001-004
npm run scwbs -- status
npm run scwbs -- review-queue
npm run scwbs -- wbs validate
npm run scwbs -- wbs apply change-set.json
```

`review-queue` prints tasks that are likely waiting on human review next, distinguishes nodes that are ready for review from nodes still blocked by unfinished dependencies, surfaces branch and PR metadata when available, shows approval status from `contracts/approvals/*.yaml` when present, and warns when review metadata is still missing.

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

After building:

```bash
npm run build
node dist/cli.js --help
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run typecheck
npm run build
```

## MVP Scope

Implemented in v0.1:

- WJS-backed WBS validation
- `contracts/wbs/project.wbs.json` initialization
- Task Contract and Evidence validation
- Done-task Evidence checks
- Document health checks for Evidence trust and contract freshness
- Optional Contract Lock checks for stale WBS revisions, WBS node IDs, and Spec versions
- Task Contract Lock generation from WBS and Spec content hashes
- First-class Spec Contract files under `contracts/specs/*.yaml`
- Test quality health checks through Evidence `testQuality`
- Git diff checks against `allowedPaths`, `forbiddenPaths`, and `humanGateRequiredPaths`
- AI Work Packet generation with relation-depth filtering
- AI blocked-task change-set generation and next-task candidate listing
- Task Contract draft generation from WBS nodes
- WBS status summary
- Review queue listing for likely human-review candidates
- Task Contract branch naming and Evidence git metadata for branch-per-task workflows
- WJS semantic operation apply wrapper

Not included yet:

- Web UI
- SQLite index
- GitHub Actions integration
- Pull request comments
- Markdown auto-generation
- Spec change proposals
- Provenance-aware Evidence verification
- Independent review automation

## Methodology

Read the SC-WBS methodology here:

```text
docs/sc-wbs-development.md
```

Current follow-up items are tracked in:

```text
docs/implementation-gaps.md
```
