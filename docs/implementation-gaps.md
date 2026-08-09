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
- Safe AI tool adapter generation and divergence-aware updates through `init` / `update`
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
- Bounded Phase 1 AI execution runner with one-Task implementer/checks/fresh-reviewer orchestration, versioned plan/result/receipt artifacts, shell-free adapter invocation, and fail-closed authority/Human Gate boundaries; debugger, retry, resume, PR, and merge automation remain excluded

## Still Missing

| Area                     | Missing Piece                                               | Why It Matters                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change control           | Spec Change Proposal command and workflow enforcement       | Spec Change Proposal files exist, but creation and Level 2 gating are not yet automated                                                                                                                                         |
| Risk management          | Risk Register format and command                            | Strict workflows still need a formal risk log                                                                                                                                                                                   |
| Evidence trust           | External artifact signatures and independent CI attestation | Tracked patch retention now reconstructs subject trees locally, but artifact signing remains out of scope                                                                                                                       |
| Evidence diff basis      | CI correlation and publish-time PR metadata gating          | `evidence collect` records branch-diff provenance and can attach a verified coverage receipt with PR/head/workflow/artifact provenance; a dedicated publish gate and full required-check CI receipt correlation remain separate |
| Test quality             | Diff-aware assertion and coverage inspection                | Combined coverage inputs are parsed into a versioned receipt and retained Evidence snapshot; source-diff comparison and threshold gating remain intentionally out of scope                                                      |
| Review independence      | Human review transition and external reviewer promotion      | Phase 1 can collect a fresh reviewer result but does not create human-only Review transitions or promote a reviewer result into completion                                                                                   |
| CI integration           | PR feedback and CI evidence correlation                     | GitHub Actions retain a read-only coverage Evidence snapshot and artifact provenance, but PR feedback and automatic promotion into tracked Evidence are not wired into the workflow                                             |
| Documentation automation | Markdown generation from contracts                          | Human-maintained docs still need manual upkeep                                                                                                                                                                                  |
| Indexing                 | SQLite or other local index                                 | We do not yet have a searchable cache for contracts and findings                                                                                                                                                                |
| WBS collaboration        | Semantic merge implementation or distributed WBS support    | The mitigation strategy is documented, but merge assistance is not implemented yet                                                                                                                                              |

## Near-Term Follow-Ups

- Add a command to create lightweight spec-change proposal artifacts.
- Parse test diffs or coverage summaries instead of relying only on `testQuality` metadata. Prefer AST-based assertion counting where practical, and coverage-report comparison as the lower-cost first step.
- Implement a low-cost WBS semantic merge helper before full distributed WBS support.
- Run read-only inventory after the patch-retention merge and backfill only historical Evidence whose recorded subject, base, diffHash, and changedFiles can be reproduced.
- Use `npm run scwbs -- evidence prune --json` to inspect the current tracked payload inventory. The command is intentionally read-only: it reports archived Task candidates but does not select a cutoff, delete payloads, upload archives, or rewrite Git history.
- Add PR feedback and CI run metadata capture for Evidence once the contract model stabilizes.
