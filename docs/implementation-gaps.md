# Implementation Gaps

This document tracks the pieces that are intentionally still missing from the current MVP.

## Already Implemented

- `scwbs check` for structural contract validation
- `scwbs health` for basic freshness and trust warnings
- Task Contract and Evidence validation
- Git diff path checks
- AI Work Packet generation with relation-depth filtering
- Optional Contract Lock metadata validation
- Evidence `testQuality` metadata validation
- AI blocked-task change-set generation
- Planned-task candidate listing for simple queue handoff
- WBS status summary
- WJS semantic apply wrapper

## Still Missing

| Area | Missing Piece | Why It Matters |
|---|---|---|
| Contract freshness | First-class Spec Contract files with `status`, `version`, `approvedBy`, `approvedAt` | Contract Lock can compare registry metadata, but approved Spec Contract artifacts are not yet formalized |
| Contract locking | Lock generation and lock refresh commands | The CLI validates optional lock metadata, but it does not yet create or update locks automatically |
| Change control | Spec Change Proposal format and command | Spec gaps still rely on ad hoc human coordination |
| Risk management | Risk Register format and command | Strict workflows still need a formal risk log |
| Evidence trust | CI artifact verification and stronger provenance checks | Evidence is still mostly heuristic and metadata-driven |
| Test quality | Diff-aware assertion and coverage inspection | `testQuality` is validated as metadata, but source diffs and coverage reports are not parsed yet |
| Health checks | Timestamp-based drift detection for code vs contracts | `scwbs health` does not yet prove freshness from history |
| Review independence | Separate independent review mode | Single-session review is still policy-driven, not enforced by the tool |
| CI integration | GitHub Actions and PR feedback | The checks run locally but are not wired into the repo automation |
| Documentation automation | Markdown generation from contracts | Human-maintained docs still need manual upkeep |
| Indexing | SQLite or other local index | We do not yet have a searchable cache for contracts and findings |
| Task queue | Dependency-aware and priority-aware next-task selection | `ai next-task` only lists simple planned candidates that avoid Human Gate paths |

## Near-Term Follow-Ups

- Add first-class Spec Contract files and schema validation.
- Add commands to create and refresh Task Contract locks.
- Introduce a lightweight spec-change proposal artifact.
- Parse test diffs or coverage summaries instead of relying only on `testQuality` metadata.
- Make `ai next-task` dependency-aware and priority-aware.
- Add a provenance-aware evidence verifier.
- Wire the current checks into CI once the contract model stabilizes.
