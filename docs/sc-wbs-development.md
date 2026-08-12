# SC-WBS開発

この文書は、SC-WBS 開発の基本方針と標準作業入口を日本語で示す。

SC-WBS DevelopmentはAI-Collaborative Spec Contract and WBS Driven Developmentである。

このファイルは意図的に短くしている。詳細なmethodologyとtool operationは`docs/scwbs/`配下へ分割し、agentがtaskに必要なcontextだけを読めるようにする。

初回利用では`docs/scwbs/getting-started.md`から始める。AI implementationまたはreview workでは、`docs/scwbs/ai-agent-guide.md`とactive Task Contractから始める。

## 正本ソース

- WBSの正本: `contracts/wbs/project.wbs.json`
- WBS-JSON実装: `wjs/`
- Task Contract: `contracts/tasks/*.yaml`
- Evidence: `contracts/evidence/*.yaml`
- Registry: `contracts/registry.yaml`

## Required Working Rules

- 明示的にapproveされない限り、assigned Task Contract外へ実装しない。
- `contracts/wbs/project.wbs.json`をWBS source of truthとして使う。
- WBS変更は`contracts/changesets/*.json`配下のWJS semantic operation change setで提案する。
- `contracts/wbs/project.wbs.json`を直接編集せず、`scwbs wbs apply`とchange setを使う。
- Done前にWJS validate toolでWBSとoperation fileを検証する。
- PRを開く前に`contracts/evidence/<task-id>.yaml`を作成またはrefreshする。
- Done前に`npm run scwbs -- check-diff --task <task-id>`を実行する。
- 1つのTask Contractを1つのbranchで扱う。`check-diff`は`branchName`とのbranch mismatchをrejectする。
- WBS nodeを`completed`にしない。Evidenceとreviewが揃った後のcompletionはhuman reviewが決める。

## Detailed References

- `docs/scwbs/getting-started.md` - 人間向けのfirst-use walkthrough。
- `docs/scwbs/ai-agent-guide.md` - implementation/review AI向けminimum-context rule。
- `docs/scwbs/README.md` - split-document index。
- `docs/scwbs/overview.md` - basic policy、source-of-truth rule、flow、bootstrap contract。
- `docs/scwbs/wbs-json.md` - WBS-JSON operation policy、WBS operation workflow、`scwbs wbs apply` usage。
- `docs/scwbs/task-contract.md` - Task Contractとlock rule。
- `docs/scwbs/ai-work-packet.md` - AI Work Packet rule。
- `docs/scwbs/contract-enforcement.md` - `check-diff`、path constraint、tool-only WBS gate、health check、branch workflow。
- `docs/scwbs/evidence-human-gate-review.md` - Evidence、Human Gate、Review、DoD、status management。
- `docs/scwbs/operations-profile-and-specs.md` - profile、principle、subtree phase、Spec Contract file。
- `docs/scwbs/cli-reference.md` - command example。
- `docs/scwbs/wjs-operations-validation.md` - WJS validateとoperation schema workflow。

## Minimal Validation

```bash
npm run scwbs -- check
npm run scwbs -- check-diff --task <task-id>
npm test
npm run typecheck
npm run build
```
