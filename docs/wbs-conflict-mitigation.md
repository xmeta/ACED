# WBS Conflict Mitigation

This note defines the near-term conflict strategy for `contracts/wbs/project.wbs.json`.

## Problem

`contracts/wbs/project.wbs.json` is the canonical WBS document. A single canonical JSON file is easy to validate, but it can become a merge hotspot when several humans or AI agents add nodes, relations, or artifacts in parallel.

The current project should keep the single canonical file for now. Full distributed WBS support is useful, but it is larger than the immediate problem.

The 2026-06-30 PR #15 conflict showed a second hotspot: generated SC-WBS contract paths such as `contracts/tasks/SCWBS-028.yaml` can collide even when the WBS JSON itself is mergeable. The expensive part was not the textual merge; it was reassigning the task ID, refreshing Evidence, rerunning CI, and waiting for GitHub to prove the PR was mergeable again.

## Near-Term Strategy

Use semantic change sets as the preferred collaboration unit.

Agents should not regenerate the whole WBS. They should propose small `wjs` semantic operations, such as:

```json
{
  "schemaVersion": "0.1.0",
  "targetWbsId": "scwbs",
  "changeSetId": "changeset-add-task-node",
  "author": "ai-agent",
  "reason": "Add planned work package",
  "dryRun": true,
  "operations": [
    {
      "operation": "addNode",
      "node": {
        "id": "node-new-work",
        "parentId": "node-project",
        "code": "1.9",
        "name": "New work package",
        "type": "workPackage",
        "status": "planned"
      },
      "position": {
        "mode": "last"
      }
    }
  ]
}
```

The safe workflow is:

```bash
npm run scwbs -- wbs apply change-set.json
npm run scwbs -- check
```

Only after review should the change be applied with `--force --output contracts/wbs/project.wbs.json`.

Before collecting final Evidence or opening a PR, agents should refresh their view of `origin/main` and run:

```bash
git fetch origin
npm run scwbs -- health
npm run scwbs -- check-diff --task <task-id>
```

`scwbs health` warns when the current branch is behind `origin/main` and when both sides added the same high-cost SC-WBS contract path with different content. Treat these warnings as a stop-and-reassign signal before more Evidence or CI time is spent.

## Merge Assistance Roadmap

The low-cost implementation path is:

1. Warn when a branch is behind `origin/main` before final Evidence is collected.
2. Warn when both sides added the same `contracts/tasks`, `contracts/evidence`, `contracts/approvals`, or `contracts/changesets` path with different content.
3. Add a `scwbs wbs plan` or `scwbs wbs propose` helper that emits dry-run change-set templates.
4. Add validation that rejects full-file WBS rewrites when a semantic change set would be sufficient.
5. Add a semantic merge helper that can replay non-conflicting change sets onto the current WBS.
6. Consider distributed WBS imports only after semantic change-set workflows prove insufficient.

## Distributed WBS Option

If the single-file model becomes a real bottleneck, introduce feature-level WBS fragments later:

```text
contracts/wbs/project.wbs.json
contracts/wbs/features/search.wbs.json
contracts/wbs/features/auth.wbs.json
```

The main WBS would remain the validation entry point. Fragment support must define deterministic import order, ID uniqueness rules, relation resolution, and artifact resolution before it is allowed in Strict workflows.

## Current Rule

Until distributed WBS exists, all WBS updates must preserve these rules:

* Do not rewrite the whole WBS to add a small change.
* Prefer semantic operations and dry-run previews.
* Keep node IDs stable after Task Contracts exist.
* Regenerate affected Task Contract locks after WBS content changes.
* If `health.git.addedPathCollision` appears, rename or reassign the task before collecting final Evidence.
