# Implementation Gaps

この表は、現在の MVP で未完了または継続確認が必要な機能を日本語で管理する。

This document tracks the pieces that are intentionally still missing from the current MVP.

## Already Implemented

- `scwbs check` for structural contract validation
- `scwbs health` for basic freshness and trust warnings
- Task Contract and Evidence validation
- Task Contract draft generation from WBS nodes
- Git diff path checks
- AI Work Packet generation with relation-depth filtering
- Optional Contract Lock metadata validation
- Task Contract Lock generation from WBS and Spec content hashes
- First-class Spec Contract files under `contracts/specs/*.yaml` with required metadata validation

<!-- scwbs-capability: spec-change-proposal status=implemented -->

- First-class Spec Change Proposal files and `scwbs spec-change new` creation with Level 2 request routing
- Evidence `testQuality` metadata validation
- Base/head-aware Evidence changed file collection
- Evidence PR metadata capture and refresh preservation
- Evidence testQuality metadata capture and refresh preservation
- Stale Task Contract Lock detection and refresh policy (`task refresh --task`, `--affected`, and explicit `--all --apply`)
- Human Gate boundary for lock-only refreshes; refresh never changes Task authority fields or approves semantic contract changes
- Tracked patch Evidence retention and subject reconstruction after squash merge
- Fail-closed patch provenance verification in health/status
- Bounded legacy Evidence migration through `evidence retain`
- Read-only Evidence retention inventory and prune planning through `evidence prune` (current baseline: 148 tracked payloads / 5,933,400 bytes); deletion, external archive durability, audit trust changes, and Git history rewriting remain Human Decision work
- AI blocked-task change-set generation
- Dependency-aware planned-task candidate listing for simple queue handoff
- Priority-aware planned-task candidate listing through `ai next-task`
- Versioned, data-driven AI tool adapter registry with Codex/Claude/Cursor/Copilot support, Gemini CLI/OpenCode preview fixtures, capability/locale metadata, and divergence-aware `init` / `update` generation
- Versioned Governance Pack v1 inspection/install/update/remove dry-runs with digest lock, local pinned Git refs, additive-only policy merge, and discovery-only installed catalog
- Dependency-free stdio-only MCP server with versioned resources/tools, existing evaluator reuse, bounded protocol output, and Human-only operation exclusion

<!-- scwbs-capability: local-index status=implemented -->

- Rebuildable Node SQLite local index with provenance-aware status, bounded cross-artifact query, stale/corrupt recovery, and non-authoritative cache semantics
- Warning-only code-versus-contract timestamp drift detection through `scwbs health`
- Sensitive meta/config file guardrails in check-diff
- Subtree-scoped bootstrap phase metadata and AI packet reporting
- <!-- scwbs-capability: wbs-semantic-merge status=implemented --> Read-only WBS semantic merge planning and explicit clean-plan changeset generation
- Repository dogfooding with `contracts/wbs/project.wbs.json` and active Task Contracts
- WBS status summary
- WJS semantic apply wrapper
- Unit and integration test coverage measurement, including a CI-retained report and machine-readable Evidence snapshot
- Versioned declarative artifact workflow schema, fail-closed DAG validation, and read-only `scwbs artifact status/instructions`; workflow guidance remains advisory and cannot relax Task authority, Human Gates, required checks, or Evidence provenance
- Versioned read-only Discovery routing proposals with deterministic Spec/Task/WBS inventory, five route outcomes, brief/roadmap output, cross-Spec boundary review, and provenance; route output never mutates delivery authority
- Versioned read-only Planning Store registry with absolute-root resolution, repository trust, pinned shared Spec provenance, stale/path/cycle checks, and repository-local Task/Evidence/CI authority; remote Git and credential automation remain excluded
- Bounded AI execution runner with one-Task implementer/checks/fresh-reviewer orchestration, a versioned Phase 2 debugger/remediation receipt with a two-round cap, stale resume validation, shell-free adapter invocation, provider capability validation, bounded advisory learned notes, local execution cost metrics, and fail-closed authority/Human Gate boundaries; PR and merge automation remain excluded
- First-class release lifecycle UX for exact version checks, release-manifest subject/digest verification, offline tarball verification, and read-only upgrade proposals; npm publication and unattended upgrade remain human decisions
- WJS operations validation is fail-closed: missing or unusable canonical validation no longer downgrades to a permissive local fallback, and `doctor` reports the same repair boundary
- Segment-aware globstar semantics now cover zero-directory and nested-directory matches with shared path normalization; unsupported authority syntax is rejected by check-diff
- Finish PR readiness now reuses the merge preflight evaluator and exposes machine-readable `mergeReadiness`; pending, neutral, skipped, wrong-workflow, duplicate, and failed `validate` checks never become merge-ready
- Doctor now validates `engines.npm`, Corepack availability, the pinned `packageManager`, and workspace dependency graph health; repair plans respect the declared npm pin
- Read-only `task preflight` and `policy explain` now derive required checks, Evidence, Human Gate paths, forbidden paths, and policy reason codes without mutating Task authority
- Versioned Risk Register v1 now provides bounded `risk list/show/add/update/accept`, fixed likelihood × impact scoring, Strict fail-closed treatment/acceptance checks, Evidence-bound acceptance freshness, and trace relations; risk acceptance remains Human-only
- Local read-only `scwbs serve` now provides an offline localhost dashboard that projects existing UI/trace evaluators with bounded GET routes, CSP, secret filtering, and no write authority
- Read-only GitHub Issue intake now provides bounded normalized snapshots and dry-run Discovery candidates with digest/stale provenance; GitHub write-back and Task auto-promotion remain Human-only
- docs check now detects orphan Markdown and selected factual drift; repository capability prose is treated as a dated snapshot

## Still Missing

| Area                | Missing Piece                                                              | Why It Matters                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change control      | Spec Change workflow enforcement                                           | <!-- scwbs-capability: spec-change-workflow-enforcement status=missing --> Proposal creation and Level 2 request routing exist; broader workflow enforcement remains                                                           |
| Evidence trust      | External artifact signatures and independent CI attestation                | `evidence verify-attestation` now records bounded GitHub Artifact Attestation verification summaries; workflow permissions, trust-root adoption, and release publication remain Human-only                                     |
| Evidence diff basis | Independent external artifact signatures and publish-time promotion policy | `evidence import-ci` verifies the bounded PR readiness artifact, while `evidence verify-attestation` validates an exact artifact digest and subject identity; automatic promotion remains out of scope                         |
| Test quality        | Diff-aware assertion and coverage inspection                               | Phase 1 records changed test files, added skip/only/todo markers, and a fail-safe line-coverage delta when a verified base receipt is available; AST assertion counting and threshold gating remain intentionally out of scope |
| Review independence | Human review transition and external reviewer promotion                    | Phase 1 can collect a fresh reviewer result but does not create human-only Review transitions or promote a reviewer result into completion                                                                                     |
| CI integration      | Independent attestation and automatic promotion                            | Trusted `workflow_run` reporting plus the bounded external verifier provide provenance evidence; workflow permissions, automatic Approval/Review/merge, and unbounded annotations remain intentionally excluded                |
| WBS collaboration   | Distributed WBS support                                                    | <!-- scwbs-capability: wbs-distributed-support status=missing --> Full distributed collaboration remains outside the read-only semantic merge planner                                                                          |

## Near-Term Follow-Ups

- Extend Spec Change workflow enforcement beyond proposal creation and Level 2 request routing.
- Extend `testQualityObservation` with AST-based assertion counting where practical. Phase 1 already compares test diffs and verified coverage summaries without replacing manual `testQuality` metadata.
- Extend read-only WBS semantic merge planning toward distributed WBS support.
- Run read-only inventory after the patch-retention merge and backfill only historical Evidence whose recorded subject, base, diffHash, and changedFiles can be reproduced.
- Use `npm run scwbs -- evidence prune --json` to inspect the current tracked payload inventory. The command is intentionally read-only: it reports archived Task candidates but does not select a cutoff, delete payloads, upload archives, or rewrite Git history.
- Add release workflow permissions and attestation generation only after a separately approved threat model, repository-plan review, and Human Gate; this Task deliberately changes no `.github` workflow.
