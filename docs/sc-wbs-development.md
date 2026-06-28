# SC-WBS Development

SC-WBS Development is AI-Collaborative Spec Contract and WBS Driven Development.

This file is intentionally short. Detailed methodology and tool operations are split under `docs/scwbs/` so agents can read only the context needed for a task.

## Canonical Sources

- WBS source of truth: `contracts/wbs/project.wbs.json`
- WBS-JSON implementation: `wjs/`
- Task Contracts: `contracts/tasks/*.yaml`
- Evidence: `contracts/evidence/*.yaml`
- Registry: `contracts/registry.yaml`

## Required Working Rules

- Do not implement outside the assigned Task Contract unless explicitly approved.
- Use `contracts/wbs/project.wbs.json` as the WBS source of truth.
- Propose WBS changes through WJS semantic operation change sets under `contracts/changesets/*.json`.
- Validate WBS and operation files with the WJS validate tool before Done.
- Create or refresh `contracts/evidence/<task-id>.yaml` before opening a PR.
- Run `npm run scwbs -- check-diff --task <task-id>` before Done.
- Keep one Task Contract on one branch; `check-diff` rejects branch mismatch against `branchName`.
- Do not mark WBS nodes `completed`; human review decides completion after Evidence and review exist.

## Detailed References

- `docs/scwbs/README.md` - split-document index.
- `docs/scwbs/overview.md` - basic policy, source-of-truth rules, flow, and bootstrap contract.
- `docs/scwbs/wbs-json.md` - WBS-JSON operation policy.
- `docs/scwbs/task-contract.md` - Task Contract and lock rules.
- `docs/scwbs/ai-work-packet.md` - AI Work Packet rules.
- `docs/scwbs/contract-enforcement.md` - `check-diff`, path constraints, health checks, and branch workflow.
- `docs/scwbs/evidence-human-gate-review.md` - Evidence, Human Gate, Review, DoD, and status management.
- `docs/scwbs/operations-profile-and-specs.md` - profiles, principles, subtree phase, and Spec Contract files.
- `docs/scwbs/cli-reference.md` - command examples.
- `docs/scwbs/wjs-operations-validation.md` - WJS validate and operations schema workflow.

## Minimal Validation

```bash
npm run scwbs -- check
npm run scwbs -- check-diff --task <task-id>
npm test
npm run typecheck
npm run build
```
