# SC-WBS Design And Specification Issue Report

Date: 2026-07-02

Scope: this report reviews design and specification risks in the current `scwbs` repository. It does not propose implementation changes. Evidence is taken from the current docs, WBS, Task Contract model, Evidence model, and command implementations.

## Summary

The repository has a coherent small-CLI architecture and the core contract controls are implemented: Task Contracts constrain paths, `check-diff` checks branch diffs, Evidence records base/head metadata, and `health` warns about stale or weak evidence. The remaining problems are now less about raw code structure and more about specification completeness: several rules are documented as methodology, but the artifact format, lifecycle rule, or enforcement point is not yet defined.

The highest-risk issue is that the WBS lifecycle does not currently provide a clean place for new work. All WBS nodes are marked `completed`, including the root project node, while new follow-up work still exists in docs and user requests. That weakens `ai next-task`, makes new Task Contracts awkward, and blurs the difference between "project completed" and "current milestone completed".

## Findings

### P1: WBS status no longer represents the active backlog

Evidence:

- `contracts/wbs/project.wbs.json` marks the root `node-project` as `completed` while also reporting `progressPercent: 35`.
- The same WBS has all visible work-package nodes marked `completed`.
- `docs/scwbs/evidence-human-gate-review.md` says `planned -> inProgress -> ready -> completed` is the normal lifecycle and that AI must not mark nodes completed.
- `src/commands/ai-queue.ts` only proposes tasks whose WBS node status is `planned`.

Impact:

New work cannot be discovered through the normal planned-task queue even when legitimate follow-up work exists. A docs-only audit like this one has to attach to an already completed WBS node or require a Human Gate WBS update before any report can be written. That makes the contract model less self-service and encourages ad hoc task contracts.

Recommended follow-up:

- Add a non-completed "maintenance / audit backlog" WBS node for recurring repo governance tasks.
- Define whether the root node may be `completed` while `progressPercent` is below 100.
- Teach `scwbs check` or `health` to warn when a completed node has contradictory progress or still receives new Task Contracts.

### P1: Spec change control is acknowledged but not specified

Evidence:

- `docs/implementation-gaps.md` lists "Spec Change Proposal format and command" as still missing.
- `docs/scwbs/evidence-human-gate-review.md` says Level 2 specification changes require stopping and waiting for human approval.
- `docs/scwbs/operations-profile-and-specs.md` names Spec Change Proposal as a next formal candidate.
- The only current Spec Contract is `contracts/specs/SPEC-SCWBS-METHOD.yaml`; it records approved source paths and version, but there is no companion artifact type for proposed spec changes.

Impact:

The methodology can identify that a spec change is needed, but it does not yet define a structured artifact for the proposed change, affected spec, rationale, approval state, or supersession behavior. This leaves Level 2 changes dependent on chat context or handwritten notes, which is exactly the kind of ambiguity the project is trying to avoid.

Recommended follow-up:

- Define `contracts/spec-changes/*.yaml` with fields for target spec, current version, proposed version, affected paths, rationale, risk, approval status, and linked task.
- Add registry indexing and `scwbs check` validation for the artifact.
- Update Human Gate docs so Level 2 changes have one canonical workflow.

### P1: Strict profile depends on artifacts that do not exist yet

Evidence:

- `docs/scwbs/operations-profile-and-specs.md` says Strict adds approval logs, traceability, Risk Register, and audit logs.
- `docs/implementation-gaps.md` lists Risk Register format and command as still missing.
- `docs/scwbs/evidence-human-gate-review.md` says Strict requires Level A Evidence, but `scwbs check` does not currently enforce a project profile or reject lower-trust Evidence by profile.

Impact:

Strict profile is described as an option, but the repo cannot actually validate a Strict-profile task end to end. A user may believe Strict has a defined contract surface when the core Risk Register and profile enforcement are still absent.

Recommended follow-up:

- Connect the existing WBS profile metadata to `check`, `health`, Review, and Evidence requirements.
- Define Risk Register and audit-log artifacts before advertising Strict as enforceable.
- Make `check` or `health` profile-aware so Evidence trust requirements are not only prose.

### P2: Review independence is policy-driven, not enforced

Evidence:

- `docs/scwbs/evidence-human-gate-review.md` says Independent AI Review is the Standard minimum and Self Review is Lean-only.
- `docs/implementation-gaps.md` lists separate independent review mode as missing.
- `contracts/reviews/*.yaml` exists, and `src/core/schema.ts` validates review records, but the schema does not prove reviewer independence from the implementation session.

Impact:

The review model is directionally correct, but its strongest safety claim depends on human discipline. Standard-profile work can look review-ready in files while still having been reviewed by the same actor that implemented it.

Recommended follow-up:

- Add reviewer identity/session/model metadata to Review records.
- Define what counts as independent for Lean, Standard, and Strict profiles.
- Warn in `health` when a Standard or Strict task has only self-review metadata.

### P2: Task Contract generation does not encode lifecycle intent

Evidence:

- `src/commands/task-generate.ts` can generate a Task Contract from any existing WBS node without checking whether the node is completed, blocked, or suitable for new implementation work.
- The generated draft uses broad default `allowedPaths` (`src/**`, `tests/**`, `docs/**`) and branch prefix `task/`, while current repo branches commonly use `codex/`.
- `docs/scwbs/task-contract.md` says generated contracts are drafts and require human review before locking.

Impact:

The command is useful as a scaffold, but its defaults can produce contracts that conflict with the current lifecycle or branch convention. The risk is moderate because docs correctly call it a draft, but automation may still make completed-node work look normal.

Recommended follow-up:

- Warn when generating a task for a completed WBS node.
- Use the repository branch convention or make the branch prefix configurable.
- Prefer narrower generated path defaults for docs-only or contract-only nodes when the WBS output type makes that clear.

### P2: Spec Contract freshness is shallow

Evidence:

- `contracts/specs/SPEC-SCWBS-METHOD.yaml` records `sourcePaths`, `version`, `approvedBy`, and `approvedAt`.
- Task `contractLock` can record `specVersion` and `specRevision`, and `src/commands/check.ts` can compare those values when a matching spec is resolved.
- There is no current spec-lock policy explaining when source-path changes require a spec version bump or new approval.
- `docs/implementation-gaps.md` lists lock refresh policy and stale lock refresh flow as missing.

Impact:

Spec Contracts have a version field, but the repository does not yet specify the governance rule that turns source changes into a required spec update. Without that rule, `sourcePaths` can drift from the approved semantic content.

Recommended follow-up:

- Define when edits under `sourcePaths` invalidate a Spec Contract.
- Record source-path hashes or approval basis in Spec Contracts.
- Add a refresh command that updates locks only under an explicit approval rule.

### P3: Documentation source-of-truth boundaries remain slightly noisy

Evidence:

- `docs/sc-wbs-development.md` is the canonical methodology entrypoint and links to split docs.
- The link list includes `docs/scwbs/wbs-json.md` twice.
- Some lifecycle and approval rules are split across `docs/scwbs/task-contract.md`, `docs/scwbs/evidence-human-gate-review.md`, `docs/scwbs/operations-profile-and-specs.md`, and `docs/implementation-gaps.md`.

Impact:

This is not a correctness bug, but it increases the chance that agents read one document and miss a related constraint elsewhere. The split-doc design is good for context control, but cross-document ownership needs to stay explicit.

Recommended follow-up:

- Remove duplicated index links.
- Add a short "artifact ownership" table naming the canonical doc for Task, Evidence, Review, Spec, Risk, and WBS lifecycle rules.
- Keep `implementation-gaps` linked from sections that intentionally describe future, not enforceable, behavior.

## Suggested Order

1. Create a planned maintenance/audit WBS node so future governance work has a normal Task Contract target.
2. Define Spec Change Proposal as the next missing control artifact.
3. Define profile source-of-truth and Risk Register before presenting Strict as enforceable.
4. Add warnings for completed-node task generation and contradictory WBS status/progress.
5. Add Review independence metadata and health warnings.

## Validation Notes

This report intentionally avoids code changes. It should be validated with:

```bash
npm run scwbs -- check
npm run scwbs -- check-diff --task SCWBS-039
npm test
npm run typecheck
npm run build
```
