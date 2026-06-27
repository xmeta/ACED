# Implementation Gaps

This document tracks the pieces that are intentionally still missing from the current MVP.

## Already Implemented

- `scwbs check` for structural contract validation
- `scwbs health` for basic freshness and trust warnings
- Task Contract and Evidence validation
- Git diff path checks
- AI Work Packet generation with relation-depth filtering
- Optional Contract Lock metadata validation
- Task Contract Lock generation from WBS and Spec content hashes
- Evidence `testQuality` metadata validation
- AI blocked-task change-set generation
- Dependency-aware planned-task candidate listing for simple queue handoff
- Repository dogfooding with `contracts/wbs/project.wbs.json` and active Task Contracts
- WBS status summary
- WJS semantic apply wrapper

## Still Missing

| Area | Missing Piece | Why It Matters |
|---|---|---|
| Contract freshness | First-class Spec Contract files with `status`, `version`, `approvedBy`, `approvedAt` | Contract Lock can compare registry metadata, but approved Spec Contract artifacts are not yet formalized |
| Contract locking | Lock refresh policy and commands | The CLI can create lock metadata, but it does not yet define when stale locks may be refreshed |
| Change control | Spec Change Proposal format and command | Spec gaps still rely on ad hoc human coordination |
| Risk management | Risk Register format and command | Strict workflows still need a formal risk log |
| Evidence trust | CI artifact verification and stronger provenance checks | Evidence is still mostly heuristic and metadata-driven |
| Test quality | Diff-aware assertion and coverage inspection | `testQuality` is validated as metadata, but source diffs and coverage reports are not parsed yet |
| Health checks | Timestamp-based drift detection for code vs contracts | `scwbs health` does not yet prove freshness from history |
| Review independence | Separate independent review mode | Single-session review is still policy-driven, not enforced by the tool |
| CI integration | GitHub Actions and PR feedback | The checks run locally but are not wired into the repo automation |
| Documentation automation | Markdown generation from contracts | Human-maintained docs still need manual upkeep |
| Indexing | SQLite or other local index | We do not yet have a searchable cache for contracts and findings |
| Task queue | Priority-aware next-task selection | `ai next-task` excludes Human Gate paths and unfinished dependencies, but does not yet model priority |
| Contract authoring | Task Contract draft generation | Review A correctly notes that manual contract authoring can dominate small Lean tasks |
| WBS collaboration | Distributed WBS or semantic merge support | Review A correctly notes that one canonical JSON file can become a merge hotspot |
| Safety | Implicit Human Gate for sensitive meta/config files | Review A correctly notes that config changes can be used to bypass path guardrails |
| Bootstrap | Subtree-scoped bootstrap transition | Review A correctly notes that large projects may mix bootstrap and normal operation by feature |

## Near-Term Follow-Ups

- Add first-class Spec Contract files and schema validation.
- Define a lock refresh policy for stale Task Contracts.
- Introduce a lightweight spec-change proposal artifact.
- Parse test diffs or coverage summaries instead of relying only on `testQuality` metadata. Prefer AST-based assertion counting where practical, and coverage-report comparison as the lower-cost first step.
- Make `ai next-task` priority-aware.
- Add `task generate --node <node-id>` to reduce Lean workflow contract-authoring overhead.
- Add meta-file safety defaults for package, TypeScript, test runner, CI, and git ignore changes.
- Document subtree-scoped Bootstrap transition and represent phase on WBS nodes or extensions.
- Define a low-cost WBS conflict mitigation path before full distributed WBS support.
- Add a provenance-aware evidence verifier.
- Wire the current checks into CI once the contract model stabilizes.
