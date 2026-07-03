# scwbs

`scwbs` is a TypeScript CLI for operating **SC-WBS Development**:

> AI-Collaborative Spec Contract and WBS Driven Development

The repository dogfoods SC-WBS through Task Contracts under `contracts/`. The bundled `wjs` submodule remains the canonical WBS-JSON implementation.

## SC-WBS Core Documentation Pack

This branch introduces `docs/sc-wbs-core/` as the lightweight, command-first Core documentation pack. Core narrows the default AI workflow to:

```text
Task Contract + Packet + Diff Guard + Evidence + Human Gate
```

Start here:

| Reader | First document |
|---|---|
| Human / PM | `docs/sc-wbs-core/00-index.md` |
| Implementation AI | `AGENTS.md` and the task packet |
| CLI implementation AI | `docs/sc-wbs-core/07-cli-core-spec.md` and `docs/sc-wbs-core/03-minimal-artifacts.md` |
| Migration work | `docs/sc-wbs-core/08-migration-plan.md` |

Core does not delete the existing methodology documents. The current detailed docs remain under `docs/scwbs/` and `docs/sc-wbs-development.md`.

Core should be read as the recommended simplification direction:

- Default AI context should be `Task Contract + tiny packet`, not full-methodology docs.
- `check-diff` is the primary mechanical guardrail.
- Evidence should stay machine-oriented, centered on commits, changed files, checks, and diff identity.
- WBS-JSON, registry, review queue, and richer governance remain Full-mode capabilities that can be adopted later.

## Current CLI Status

Some Core documents describe target shorthand commands such as `scwbs task new`, `scwbs packet --tiny`, `scwbs finish`, and `scwbs block`. Those are Core target specifications, not all current ACED CLI commands.

Use the current npm script commands in this repository:

```bash
npm run scwbs -- next
npm run scwbs -- start <goal>
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- ai block --task <task-id> --reason "Human Gate required"
```

Detailed current command examples live in `docs/scwbs/cli-reference.md`.

Practical reading order in the current repo:

1. `AGENTS.md`
2. The active `contracts/tasks/<task-id>.yaml`
3. `npm run scwbs -- ai packet --task <task-id> --relation-depth 1` only when the task needs more context
4. `docs/sc-wbs-core/` when you are designing or implementing the guardrail system itself

## What This Project Contains

```text
.
├── src/                     # scwbs CLI source
├── tests/                   # Vitest coverage for the CLI
├── contracts/               # SC-WBS contracts for this repository
├── docs/
│   ├── sc-wbs-core/         # lightweight Core documentation pack
│   ├── scwbs/               # current detailed SC-WBS docs
│   └── sc-wbs-development.md
├── wjs/                     # WBS-JSON submodule
├── package.json
└── tsconfig.json
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

Run the CLI during development:

```bash
npm run scwbs -- --help
```

## MVP Scope

Implemented in v0.1:

- Contract, Evidence, WBS, diff, and health validation
- AI work packets, review queues, approval requests, and lightweight orchestration helpers
- WJS-backed WBS validation, semantic operation application, and change-set checks
- Branch-per-task safeguards and Evidence git metadata
- Text-first dashboard, trace, next-action, profile, registry, and draft-generation commands

Not included yet:

- Web UI beyond the initial text dashboard / `serve` stub
- SQLite index
- Core shorthand commands listed as future target specs in `docs/sc-wbs-core/`
