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

Detailed command examples live in:

```text
docs/scwbs/cli-reference.md
```

WBS change-set and WJS validation rules live in:

```text
docs/scwbs/wjs-operations-validation.md
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

- Contract, Evidence, WBS, diff, and health validation
- AI work packets, review queues, approval requests, and lightweight orchestration helpers
- WJS-backed WBS validation, semantic operation application, and change-set checks
- Branch-per-task safeguards and Evidence git metadata
- Text-first dashboard, trace, next-action, profile, registry, and draft-generation commands

Not included yet:

- Web UI beyond the initial text dashboard / `serve` stub
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
