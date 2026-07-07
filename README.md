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
| Docs navigator | `docs/README.md` |
| AI implementation agent | `AGENTS.md`, then `contracts/tasks/<task-id>.yaml` |
| AI reviewer | `docs/scwbs/ai-agent-guide.md` |
| CLI/reference user | `docs/scwbs/cli-reference.md` |
| SC-WBS Core designer | `docs/sc-wbs-core/00-index.md` |

Do not start by reading every file under `docs/`. The intended workflow is
small context first, deeper docs only when needed.

## 1. What This Tool Is

`scwbs` is a guardrail CLI for AI-assisted work. It gives each change an
explicit Task Contract, checks the changed files against that contract, records
Evidence, and sends risky work back to Human Gate.

## 2. Minimal Setup

Install dependencies:

```bash
npm install
npm install --prefix wjs
```

Check the local installation:

```bash
npm run scwbs -- doctor
npm run scwbs -- check
```

## 3. Doctor And Check

Use `doctor` for setup diagnostics and `check` for contract/registry health:

```bash
npm run scwbs -- doctor
npm run scwbs -- doctor --fix
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
```

`doctor` reports PASS / FAIL for Node.js, npm, the root `node_modules`,
`wjs/node_modules`, `git`, `contracts/registry.yaml`,
`contracts/wbs/project.wbs.json`, and `wjs/schema/wbs-json.schema.json`,
plus any check / health issues. Each FAIL prints a suggested fix command.

`doctor --fix` only runs safe repairs (for example `npm install` and
`npm install --prefix wjs`). It refuses destructive operations; for
anything risky, follow the printed suggested fix command instead.

Run `doctor` before `check` whenever setup may be incomplete so failures
are diagnosed explicitly instead of surfacing as opaque errors.

## 4. AI Minimum Flow

AI agents should start from the active Task Contract and avoid broad docs
scans. Use the tiny packet only when more context is needed:

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

Finish with machine checks, Evidence, and diff validation:

```bash
npm run scwbs -- finish --task <task-id>
npm run scwbs -- check-diff --task <task-id>
```

If a stop condition is hit, block instead of guessing:

```bash
npm run scwbs -- block "Human Gate required" --task <task-id>
```

## 5. Human Reviewer Flow

Humans review the PR, Evidence, and current diff before approving. AI agents
must not run approval commands on behalf of a human.

```bash
npm run scwbs -- review-queue
npm run scwbs -- approve --task <task-id> --pr <number> --reason "Evidence and PR reviewed"
```

The detailed command is also available:

```bash
npm run scwbs -- approval approve --task <task-id> --pull-request "#<number>" --reason "Evidence and PR reviewed"
```

## 6. Core Artifacts

- Task Contract: `contracts/tasks/<task-id>.yaml`
- Evidence: `contracts/evidence/<task-id>.yaml`
- Approval: `contracts/approvals/<task-id>.yaml`
- Block: `contracts/blocks/<task-id>.yaml`
- Registry: `contracts/registry.yaml`

## 7. Profiles

Profiles tune validation strictness:

```bash
npm run scwbs -- profile show
npm run scwbs -- profile set lean
npm run scwbs -- profile set standard
npm run scwbs -- profile set strict
```

Use `lean` for small local dogfood tasks, `standard` for normal repository
work, and `strict` when broader governance checks are required.

## 8. Common Errors

- Outside `allowedPaths`: stop, narrow the change, or update the Task Contract
  before editing.
- Under `forbiddenPaths`: stop and block; forbidden paths override allowed
  paths.
- Human Gate required: stop and use `block`.
- Stale Evidence: rerun `finish` after the final diff is in place.
- Stale Approval scope: a human must re-review and approve the current diff.

## 9. Developer Commands

Create a small task:

```bash
npm run scwbs -- task new "Update docs" --paths "docs/**"
```

Switch to the branch printed by the Task Contract:

```bash
git switch -c <branchName>
```

Tests are split into two groups:

- `tests/unit/` – fast, lightweight tests used by the default `npm test` command.
- `tests/integration/` – heavier tests that create temporary Git repositories.

Run the full local verification set:

```bash
npm test                    # unit tests only (fast)
npm run test:integration    # integration tests (heavier)
npm run test:all            # all tests
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
npm run scwbs -- finish --task <task-id>
npm run scwbs -- block "Human Gate required" --task <task-id>
npm run scwbs -- request-approval --task <task-id> --pr <number>
```

Detailed examples live in `docs/scwbs/cli-reference.md`.

## Repository Layout

```text
.
├── src/                     # scwbs CLI source
├── tests/
│   ├── unit/                # fast unit tests (npm test)
│   ├── integration/         # heavier integration tests (npm run test:integration)
│   └── helpers.ts           # shared test utilities
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

Status: current repository entrypoint.

- Current execution rules: `AGENTS.md` and the active Task Contract.
- Task scope: `contracts/tasks/<task-id>.yaml`.
- Completion evidence: `contracts/evidence/<task-id>.yaml`.
- Documentation map: `docs/README.md`.
- Current Core reference: `docs/sc-wbs-core/00-index.md`.
- Legacy/detail reference: `docs/scwbs/`.
- Proposal/design notes: `docs/sc-wbs-core-revision/`.

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
