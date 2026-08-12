# SC-WBS開発リファレンス

Status: legacy/detail reference。

SC-WBSの詳細をここへ分割し、人間とagentがcurrent taskに必要なfileだけ読めるようにしている。

このrepositoryのcurrent workでは、`../../README.md`、`../../AGENTS.md`、active Task Contractから始める。これらのentrypointまたはtaskがdetailed SC-WBS methodやCLI referenceを要求する場合に、このdirectoryを使う。

## entry point

- `getting-started.md` - このrepositoryの人間向けfirst-use walkthrough。
- `ai-agent-guide.md` - implementation/review AI向けminimum-context rule。
- `cli-reference.md` - detailed command exampleのresponsibility-based index。
- `cli-core-checks.md`、`cli-task-evidence.md`、`cli-approval-risk.md`、`cli-wbs-github.md`、`cli-mutation-output.md` - responsibility別のdetailed command reference。
- `../sc-wbs-development.md` - short methodology hub。

## 方法論

- `overview.md` - basic policy、source-of-truth rule、flow、bootstrap contract。
- `wbs-json.md` - WBS-JSON operation policyとHuman Gate write rule。
- `task-contract.md` - Task Contract field、lock freshness、scope rule。
- `ai-work-packet.md` - AI Work Packet contentとpre-work requirement。
- `contract-enforcement.md` - `check-diff`、path rule、health check、branch-per-task review flow。
- `evidence-human-gate-review.md` - Evidence、Human Gate、review、Definition of Done（完了定義）、status management。
- `operations-profile-and-specs.md` - operating profile、Core principle、Subtree Phase、Spec Contract file。

## ツールリファレンス

- `cli-reference.md` - detailed CLI indexとresponsibility link。
- `wjs-operations-validation.md` - WJS validateとoperation schema workflow。
- `merge-protection.md` - main branch merge enforcement boundaryとfail-closed merge path。
- `integration-testing.md` - integration test runnerのparallelism、isolation、duration report。
