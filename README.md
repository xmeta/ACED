# scwbs

`scwbs` is a TypeScript CLI for operating **SC-WBS Development**:

> AI-Collaborative Spec Contract and WBS Driven Development

The tool keeps AI-assisted work inside an explicit Task Contract. It records
Evidence, checks changed files against the contract, and routes risky changes
back to Human Gate instead of letting an AI guess.

## Start Here

| Reader | Read this first |
|---|---|
| New human user | `docs/scwbs/getting-started.md` |
| AI implementation agent | `AGENTS.md`, then `contracts/tasks/<task-id>.yaml` |
| AI reviewer | `docs/scwbs/ai-agent-guide.md` |
| CLI/reference user | `docs/scwbs/cli-reference.md` |
| SC-WBS Core designer | `docs/sc-wbs-core/00-index.md` |

Do not start by reading every file under `docs/`. The intended workflow is
small context first, deeper docs only when needed.

## Quick Start For This Repository

Install dependencies:

```bash
npm install
```

Inspect the next suggested action:

```bash
npm run scwbs -- next
```

Create a small task:

```bash
npm run scwbs -- task new "Update docs" --paths "docs/**"
```

Switch to the branch printed by the Task Contract, then start the task:

```bash
git switch -c <branchName>
npm run scwbs -- start <task-id>
```

Give an AI the smallest useful context:

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

Finish with machine checks instead of a handwritten Done claim:

```bash
npm test
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- registry rebuild --check
```

For a walkthrough with decision points, use
`docs/scwbs/getting-started.md`.

## What AI Agents Must Not Do

- Do not work without a Task Contract.
- Do not change files outside `allowedPaths`.
- Do not change `forbiddenPaths`.
- Do not treat implementation notes or chat as Ground Truth.
- Do not approve Human Gate decisions on behalf of a human.
- Do not call a task Done until Evidence and `check-diff` pass.

The current repository-specific rules are in `AGENTS.md`.

## Current Command Surface

Run all CLI commands through the npm script while working in this repository:

```bash
npm run scwbs -- --help
```

Common commands:

```bash
npm run scwbs -- next
npm run scwbs -- task new "作業名" --paths "src/**,tests/**"
npm run scwbs -- start <task-id>
npm run scwbs -- packet --task <task-id> --tiny
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
```

Detailed examples live in `docs/scwbs/cli-reference.md`.

## Repository Layout

```text
.
├── src/                     # scwbs CLI source
├── tests/                   # Vitest coverage for the CLI
├── contracts/               # SC-WBS contracts for this repository
├── docs/
│   ├── scwbs/               # current user and tool docs
│   ├── sc-wbs-core/         # lightweight Core documentation pack
│   └── sc-wbs-core-revision/ # draft revision notes, not current rules
├── wjs/                     # WBS-JSON submodule
├── package.json
└── tsconfig.json
```

## Source Of Truth

- Current execution rules: `AGENTS.md` and the active Task Contract.
- Task scope: `contracts/tasks/<task-id>.yaml`.
- Completion evidence: `contracts/evidence/<task-id>.yaml`.
- Current command examples: `docs/scwbs/cli-reference.md`.
- Core target design: `docs/sc-wbs-core/`.
- Draft future design: `docs/sc-wbs-core-revision/`.

When these disagree during real work, prefer `AGENTS.md` and the active Task
Contract.

## MVP Scope

Implemented in v0.1:

- Contract, Evidence, WBS, diff, and health validation.
- AI work packets, review queues, approval requests, and lightweight
  orchestration helpers.
- WJS-backed WBS validation, semantic operation application, and changeset
  checks.
- WBS-less task index operation, WBS candidate generation, and WBS changeset
  reproduction checks.
- Branch-per-task safeguards and Evidence git metadata.
- Text-first dashboard, trace, next-action, profile, registry, and
  draft-generation commands.

Not included yet:

- Web UI beyond the initial text dashboard / `serve` stub.
- SQLite index.
- Fully external installer experience.
