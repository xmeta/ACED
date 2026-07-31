# scwbs

`scwbs` is a TypeScript CLI for operating **SC-WBS Development**:

> AI-Collaborative Spec Contract and WBS Driven Development

The tool keeps AI-assisted work inside an explicit Task Contract. It records
Evidence, checks changed files against the contract, and routes risky changes
back to Human Gate instead of letting an AI guess.

## License

Unless a file states otherwise, the `scwbs` source code and repository-authored
documentation are licensed under the GNU General Public License version 3.0
only. See [LICENSE](LICENSE) for the full license text. The `wjs` submodule is
a separate dependency and retains its own licensing terms.

## Start Here

| Reader | Read this first |
|---|---|
| New human user | `docs/scwbs/getting-started.md` |
| Human contributor | `CONTRIBUTING.md` |
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

This repository supports Node.js `>=22.12.0` and npm `>=10`. It pins npm
`10.9.0` through `packageManager`; enable Corepack before installing so the
lockfile is produced by the supported npm release. CI verifies both the
minimum supported Node.js version and the current LTS version.

The required WJS schema is kept in the `wjs` Git submodule. After a normal
clone, initialize the submodule before installing dependencies:

```bash
git submodule update --init --recursive wjs
```

Install dependencies:

```bash
corepack enable
corepack npm install
```

Check the local installation:

```bash
npm run scwbs -- doctor
npm run scwbs -- check
npm run scwbs -- docs check
```

## 3. Doctor And Check

Use `doctor` for setup diagnostics and `check` for contract/registry health:

```bash
npm run scwbs -- doctor
npm run scwbs -- doctor --fix
npm run scwbs -- check
npm run scwbs -- status
npm run scwbs -- status --strict
npm run scwbs -- registry rebuild --check
```

`doctor` reads the Node.js requirement from `package.json` and reports PASS /
FAIL for that range, npm, the root `node_modules`,
`wjs/node_modules`, `git`, `contracts/registry.yaml`,
`contracts/wbs/project.wbs.json`, and `wjs/schema/wbs-json.schema.json`,
plus any check / health issues. Each FAIL prints a suggested fix command.

`doctor --fix` only runs safe repairs (for example `npm install`). It refuses destructive operations; for anything risky, follow the printed suggested fix command instead.

Run `doctor` before `check` whenever setup may be incomplete so failures
are diagnosed explicitly instead of surfacing as opaque errors.

`docs check` validates `docs/document-lifecycle.json`, including document-set
status, entrypoints, normative ownership, successor links, and compatibility
with the current CLI version. Its `--json` output is suitable for CI tooling;
the same errors are included in the aggregate `scwbs check`.

`status` keeps WBS lifecycle counts separate from completion trust. A completed
or archived Task is only `verified` when its required checks, Evidence subject,
and any Human Approval scope remain verifiable; `--strict` returns a non-zero
status when terminal Task trust is degraded, unverifiable, or not evaluated.

## 4. AI Minimum Flow

AI agents should start from the active Task Contract and avoid broad docs
scans. Use the tiny packet by default (`--tiny` is the default):

```bash
npm run scwbs -- packet --task <task-id>
```

Use `--standard` or `--full` only when more context is needed:

```bash
npm run scwbs -- packet --task <task-id> --standard
npm run scwbs -- packet --task <task-id> --full
```

Finish with required checks, Evidence, diff validation, and registry check in a single command:

```bash
npm run scwbs -- finish --task <task-id>
```

`finish` runs everything automatically: required checks, Evidence collection, diff guard, and registry consistency check. It also detects Human Gate paths and shows the next action for human reviewers.

If a stop condition is hit, block instead of guessing:

```bash
npm run scwbs -- block "Human Gate required" --task <task-id>
```

## 5. Human Reviewer Flow

Humans review the PR, Evidence, and current diff before approving. AI agents
must not run approval commands on behalf of a human.

```bash
npm run scwbs -- review-queue
npm run scwbs -- approve --task <task-id> --pr <number> --actor human --reason "Evidence and PR reviewed"
```

The detailed command is also available:

```bash
npm run scwbs -- approval approve --task <task-id> --pull-request "#<number>" --actor human --reason "Evidence and PR reviewed"
```

`finish` uses this implemented command shape for its Human Gate next action. It does not emit unsupported `--approved-by` or `--human-confirm` options.

After approval and successful CI, merge through the fail-closed SC-WBS path:

```bash
npm run scwbs -- merge --pr <number> --preflight-only --json
npm run scwbs -- merge --pr <number>
```

The command requires an open, non-draft PR targeting `main`, a `CLEAN` merge
state, the current checkout's GitHub `origin`, and exactly one successful
aggregate `validate` check from the `scwbs` workflow and repository. It binds
the merge to the checked PR head with
`--match-head-commit`; pending, failed, cancelled, skipped, missing, or
ambiguous `validate` results are rejected. Do not replace this normal path
with direct `gh pr merge`, `--admin`, or `--auto`.

This repository is currently private on a GitHub plan where branch protection
and repository rulesets are unavailable. The local command therefore improves
the normal merge path but cannot prevent direct/force pushes or privileged API
and administrator bypasses. Changing repository visibility, GitHub plan,
external cost, or permissions requires a Human Decision. See
[`docs/scwbs/merge-protection.md`](docs/scwbs/merge-protection.md).

Unattended execution is an explicit, per-Task exception. The Task Contract must contain a locked `approvalPolicy.mode: delegated` policy with the delegator, AI target, allowed scopes (`human-gate` and/or `post-finish`), source, reason, expiry, and SHA-256 hash of an external token. The token itself is supplied only through `SCWBS_APPROVAL_DELEGATION_TOKEN`; it must not be committed or stored in contracts or Approval records.

```bash
SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" \
  npm run scwbs -- approval approve --task <task-id> --pull-request "#<number>" \
  --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
```

A local `.env` file or CI secret store may be used to manage the environment variable, but the CLI does not automatically load `.env`, and `.env` alone never grants authority. Use a randomly generated token of at least 32 bytes; the public SHA-256 in the contract otherwise permits offline guessing of weak secrets. The committed Task Contract policy and a matching, unexpired token are both required. Delegated records use `approvalMode: delegated` and a token-derived `delegationProof`, and record their declared source, delegator, executor, and scope separately from human approvals. Consumers revalidate the proof and accept `human-gate` only for Human Gate checks and `post-finish` only for completion. These controls make accidental and simple YAML bypasses substantially harder, but they do not independently verify the real-world identity of `delegatedBy`, the person who provisioned the token, or a fully privileged process that can rewrite both code and local secrets.

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
`profile set` writes a `setDocumentExtension` changeset under
`contracts/changesets/` and applies it through WJS; it does not directly edit
the canonical WBS. Because the profile participates in the global Task lock,
review `npm run scwbs -- task refresh --affected` after changing it.

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
npm run scwbs -- task new "Update docs" --paths "docs/scwbs/getting-started.md" --stop "source change required"
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
npm run scwbs -- finish --task <task-id>
npm run scwbs -- registry rebuild --check
```

`npm run typecheck` runs three checks in sequence: production TypeScript,
test TypeScript, and the dependency-free JavaScript runners in `scripts/`.
The production build continues to use `tsconfig.json`. Test code uses
`tsconfig.tests.json` with no output, while scripts use `scripts/tsconfig.json`
with `checkJs`; implicit JavaScript parameter types remain a documented
migration boundary, but other inferred type errors are checked.

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
npm run scwbs -- task new "作業名" --paths "src/commands/example.ts,tests/integration/example.test.ts" --stop "schema or dependency change required"
npm run scwbs -- start <goal>
npm run scwbs -- packet --task <task-id>           # tiny (default)
npm run scwbs -- packet --task <task-id> --standard
npm run scwbs -- packet --task <task-id> --full
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- finish --task <task-id>           # standard completion command
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
- Canonical artifact schemas: `src/core/schema/records.ts` (AJV JSON Schema).
  - `ApprovalRecord`: flat structure with top-level `pullRequest`, `headCommit`, `diffHash` (no nested `scope`).
  - `BlockRecord`: requires `level`, `category`, `requiredHumanDecision`, `createdAt`; optional `history[]`.
  - Schema version follows `schemaVersion` in `contracts/wbs/project.wbs.json`.

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
