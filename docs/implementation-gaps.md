# Implementation Gaps

This document tracks the pieces that are intentionally still missing from the current MVP.

## Already Implemented

- `scwbs check` for structural contract validation
- `scwbs health` for basic freshness and trust warnings
- Task Contract and Evidence validation
- Git diff path checks
- AI Work Packet generation
- WBS status summary
- WJS semantic apply wrapper

## Still Missing

| Area | Missing Piece | Why It Matters |
|---|---|---|
| Contract freshness | Spec Contract `status`, `version`, `approvedBy`, `approvedAt` | We still cannot lock a task to a specific approved spec revision |
| Contract locking | Contract Lock metadata and checks | Tasks can drift from the spec or WBS snapshot they were generated from |
| Change control | Spec Change Proposal format and command | Spec gaps still rely on ad hoc human coordination |
| Risk management | Risk Register format and command | Strict workflows still need a formal risk log |
| Evidence trust | CI artifact verification and stronger provenance checks | Evidence is still mostly heuristic and metadata-driven |
| Health checks | Timestamp-based drift detection for code vs contracts | `scwbs health` does not yet prove freshness from history |
| Review independence | Separate independent review mode | Single-session review is still policy-driven, not enforced by the tool |
| CI integration | GitHub Actions and PR feedback | The checks run locally but are not wired into the repo automation |
| Documentation automation | Markdown generation from contracts | Human-maintained docs still need manual upkeep |
| Indexing | SQLite or other local index | We do not yet have a searchable cache for contracts and findings |

## Near-Term Follow-Ups

- Add spec/version metadata to contract schemas.
- Teach `scwbs health` to flag stale specs and stale task locks.
- Introduce a lightweight spec-change proposal artifact.
- Add a provenance-aware evidence verifier.
- Wire the current checks into CI once the contract model stabilizes.
