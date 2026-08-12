# SC-WBS開発

この文書は、SC-WBS 開発の基本方針と標準作業入口を日本語で示す。

SC-WBS Developmentは、AIと協調しながらSpec ContractとWBSを用いて開発する手法である。

このファイルは意図的に短くしている。詳細な方法論とツール操作は`docs/scwbs/`配下へ分割し、agentがTaskに必要なcontextだけを読めるようにする。

初回利用では`docs/scwbs/getting-started.md`から始める。AIによる実装またはReview作業では、`docs/scwbs/ai-agent-guide.md`とactive Task Contractから始める。

## 正本ソース

- WBSの正本: `contracts/wbs/project.wbs.json`
- WBS-JSON実装: `wjs/`
- Task Contract: `contracts/tasks/*.yaml`
- Evidence: `contracts/evidence/*.yaml`
- Registry: `contracts/registry.yaml`

## 必須の作業ルール

- 明示的にapproveされない限り、割り当てられたTask Contractの範囲外へ実装しない。
- `contracts/wbs/project.wbs.json`をWBSの正本として使う。
- WBS変更は`contracts/changesets/*.json`配下のWJS semantic operation change setで提案する。
- `contracts/wbs/project.wbs.json`を直接編集せず、`scwbs wbs apply`とchange setを使う。
- Done前にWJS validate toolでWBSとoperation fileを検証する。
- PRを開く前に`contracts/evidence/<task-id>.yaml`を作成またはrefreshする。
- Done前に`npm run scwbs -- check-diff --task <task-id>`を実行する。
- 1つのTask Contractを1つのbranchで扱う。`check-diff`は`branchName`とのbranch mismatchをrejectする。
- WBS nodeを`completed`にしない。EvidenceとReviewが揃った後のcompletionは人間のReviewで決定する。

## 詳細リファレンス

- `docs/scwbs/getting-started.md` - 人間向けの初回利用手順。
- `docs/scwbs/ai-agent-guide.md` - 実装・Review AI向けの最小限のcontextルール。
- `docs/scwbs/README.md` - 分割文書の索引。
- `docs/scwbs/overview.md` - 基本方針、正本ルール、処理の流れ、bootstrap contract。
- `docs/scwbs/wbs-json.md` - WBS-JSON operation policy、WBS operation workflow、`scwbs wbs apply`の使用方法。
- `docs/scwbs/task-contract.md` - Task Contractとlock rule。
- `docs/scwbs/ai-work-packet.md` - AI Work Packetのルール。
- `docs/scwbs/contract-enforcement.md` - `check-diff`、path制約、tool-only WBS gate、health check、branch workflow。
- `docs/scwbs/evidence-human-gate-review.md` - Evidence、Human Gate、Review、DoD、status管理。
- `docs/scwbs/operations-profile-and-specs.md` - profile、principle、subtree phase、Spec Contract file。
- `docs/scwbs/cli-reference.md` - command example。
- `docs/scwbs/wjs-operations-validation.md` - WJS validateとoperation schema workflow。

## 最小検証

```bash
npm run scwbs -- check
npm run scwbs -- check-diff --task <task-id>
npm test
npm run typecheck
npm run build
```
