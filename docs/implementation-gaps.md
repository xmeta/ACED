# Implementation Gaps

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
- First-class Spec Change Proposal files under `contracts/spec-changes/*.yaml` with required metadata validation
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
- Warning-only code-versus-contract timestamp drift detection through `scwbs health`
- Sensitive meta/config file guardrails in check-diff
- Subtree-scoped bootstrap phase metadata and AI packet reporting
- WBS conflict mitigation strategy and semantic merge roadmap
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
- docs check now detects orphan Markdown and selected factual drift; repository capability prose is treated as a dated snapshot

## Still Missing

| Area                     | Missing Piece                                               | Why It Matters                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change control           | Spec Change Proposal command and workflow enforcement       | Spec Change Proposal files exist, but creation and Level 2 gating are not yet automated                                                                                                                                         |
| Risk management          | Risk Register format and command                            | Strict workflows still need a formal risk log                                                                                                                                                                                   |
| Evidence trust           | External artifact signatures and independent CI attestation | Tracked patch retention now reconstructs subject trees locally, but artifact signing remains out of scope                                                                                                                       |
| Evidence diff basis      | Independent external artifact signatures and publish-time promotion policy | `evidence import-ci` now verifies the bounded PR readiness artifact, CI receipt digest, repository/Task/PR/HEAD/workflow provenance, and atomically updates Evidence/Registry; independent external signatures and automatic promotion remain out of scope |
| Test quality             | Diff-aware assertion and coverage inspection                | Phase 1 records changed test files, added skip/only/todo markers, and a fail-safe line-coverage delta when a verified base receipt is available; AST assertion counting and threshold gating remain intentionally out of scope                  |
| Review independence      | Human review transition and external reviewer promotion      | Phase 1 can collect a fresh reviewer result but does not create human-only Review transitions or promote a reviewer result into completion                                                                                   |
| CI integration           | Independent attestation and automatic promotion             | Trusted `workflow_run` reporting now provides bounded PR feedback and a verified CI receipt import path; independent attestation, automatic Approval/Review/merge, and unbounded annotations remain intentionally excluded |
| Indexing                 | SQLite or other local index                                 | We do not yet have a searchable cache for contracts and findings                                                                                                                                                                |
| WBS collaboration        | Semantic merge implementation or distributed WBS support    | The mitigation strategy is documented, but merge assistance is not implemented yet                                                                                                                                              |

## Near-Term Follow-Ups

- Add a command to create lightweight spec-change proposal artifacts.
- Extend `testQualityObservation` with AST-based assertion counting where practical. Phase 1 already compares test diffs and verified coverage summaries without replacing manual `testQuality` metadata.
- Implement a low-cost WBS semantic merge helper before full distributed WBS support.
- Run read-only inventory after the patch-retention merge and backfill only historical Evidence whose recorded subject, base, diffHash, and changedFiles can be reproduced.
- Use `npm run scwbs -- evidence prune --json` to inspect the current tracked payload inventory. The command is intentionally read-only: it reports archived Task candidates but does not select a cutoff, delete payloads, upload archives, or rewrite Git history.
- Extend the readiness artifact with an independently verifiable external attestation only after a separately approved security design.
