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
- Tracked patch Evidence retention and subject reconstruction after squash merge
- Fail-closed patch provenance verification in health/status
- Bounded legacy Evidence migration through `evidence retain`
- AI blocked-task change-set generation
- Dependency-aware planned-task candidate listing for simple queue handoff
- Sensitive meta/config file guardrails in check-diff
- Subtree-scoped bootstrap phase metadata and AI packet reporting
- WBS conflict mitigation strategy and semantic merge roadmap
- Repository dogfooding with `contracts/wbs/project.wbs.json` and active Task Contracts
- WBS status summary
- WJS semantic apply wrapper

## Still Missing

| Area | Missing Piece | Why It Matters |
|---|---|---|
| Contract freshness | Lock refresh policy and commands | Approved Spec Contract artifacts now exist, but the CLI does not yet define when stale locks may be refreshed |
| Contract locking | Stale lock refresh flow | The CLI can create lock metadata, but it does not yet define when stale locks may be refreshed |
| Change control | Spec Change Proposal command and workflow enforcement | Spec Change Proposal files exist, but creation and Level 2 gating are not yet automated |
| Risk management | Risk Register format and command | Strict workflows still need a formal risk log |
| Evidence trust | External artifact signatures and independent CI attestation | Tracked patch retention now reconstructs subject trees locally, but artifact signing remains out of scope |
| Evidence diff basis | CI correlation and publish-time PR metadata gating | `evidence collect` records branch-diff provenance and can capture PR numbers, but CI run correlation and a dedicated publish gate are not wired into the workflow yet |
| Test quality | Diff-aware assertion and coverage inspection | `testQuality` can be recorded as Evidence metadata, but source diffs and coverage reports are not parsed yet |
| Health checks | Timestamp-based drift detection for code vs contracts | `scwbs health` does not yet prove freshness from history |
| Review independence | Separate independent review mode | Single-session review is still policy-driven, not enforced by the tool |
| CI integration | PR feedback and CI evidence correlation | GitHub Actions run the local checks, but PR feedback and Evidence links to CI runs are not wired into the workflow yet |
| Documentation automation | Markdown generation from contracts | Human-maintained docs still need manual upkeep |
| Indexing | SQLite or other local index | We do not yet have a searchable cache for contracts and findings |
| Task queue | Priority-aware next-task selection | `ai next-task` excludes Human Gate paths and unfinished dependencies, but does not yet model priority |
| WBS collaboration | Semantic merge implementation or distributed WBS support | The mitigation strategy is documented, but merge assistance is not implemented yet |

## Near-Term Follow-Ups

- Define a lock refresh policy for stale Task Contracts.
- Add a command to create lightweight spec-change proposal artifacts.
- Parse test diffs or coverage summaries instead of relying only on `testQuality` metadata. Prefer AST-based assertion counting where practical, and coverage-report comparison as the lower-cost first step.
- Make `ai next-task` priority-aware.
- Implement a low-cost WBS semantic merge helper before full distributed WBS support.
- Run read-only inventory after the patch-retention merge and backfill only historical Evidence whose recorded subject, base, diffHash, and changedFiles can be reproduced.
- Add PR feedback and CI run metadata capture for Evidence once the contract model stabilizes.
