# SC-WBS Development References

Status: legacy/detail reference.

SC-WBS details are split here so humans and agents can read only the files
needed for the current task.

For current work in this repository, start with `../../README.md`,
`../../AGENTS.md`, and the active Task Contract. Use this directory when those
entrypoints or the task require detailed SC-WBS method or CLI reference.

## Entry Points

- `getting-started.md` - first-use walkthrough for humans in this repository.
- `ai-agent-guide.md` - minimum-context rules for implementation and review AI.
- `cli-reference.md` - responsibility-based index for detailed command examples.
- `cli-core-checks.md`, `cli-task-evidence.md`, `cli-approval-risk.md`, `cli-wbs-github.md`, `cli-mutation-output.md` - detailed command references by responsibility.
- `../sc-wbs-development.md` - short methodology hub.

## Methodology

- `overview.md` - basic policy, source-of-truth rules, flow, and bootstrap contract.
- `wbs-json.md` - WBS-JSON operation policy and Human Gate write rules.
- `task-contract.md` - Task Contract fields, lock freshness, and scope rules.
- `ai-work-packet.md` - AI Work Packet content and pre-work requirements.
- `contract-enforcement.md` - `check-diff`, path rules, health checks, and branch-per-task review flow.
- `evidence-human-gate-review.md` - Evidence, Human Gate, review, Definition of Done, and status management.
- `operations-profile-and-specs.md` - operating profiles, core principles, Subtree Phase, and Spec Contract files.

## Tool References

- `cli-reference.md` - detailed CLI index and responsibility links.
- `wjs-operations-validation.md` - WJS validate and operations schema workflow.
- `merge-protection.md` - main branch merge enforcement boundary and fail-closed merge path.
- `integration-testing.md` - integration test runner parallelism, isolation, and duration reporting.
