# Blocked Review Completion Handoff Plan

作成日: 2026-07-06
対象 Task: SCWBS-DRAFT-MR8URHAZ

## 目的

`review-queue` は Review candidate を検出できているが、現在の候補は WBS node の readiness または shared-node completion prerequisites で止まっている。この文書は、高判断コストの完了順序設計と、低コスト agent に渡せる metadata-only follow-up を分離するための handoff plan である。

Ground Truth は次の順で扱う。

1. `npm run scwbs -- review-queue`
2. 対象 Task Contract / Evidence / Review record
3. WBS node status と completion prerequisites
4. `npm run scwbs -- health`

## 現状サマリ

2026-07-06 時点の `review-queue` は次の状態を示す。

- review candidates: 30
- missing pull request metadata: 0
- blocked by completion prerequisites: 30
- ready for completion review: 0

つまり、PR metadata backfill は主要 blocker ではない。次の blocker は WBS node の status と、shared node に対する dedicated node-level completion task の不足である。

## 完了順序

### 1. Governance maintenance は lead model が順序を決める

対象 node: `node-governance-maintenance`

代表候補:

- SCWBS-041..053
- SCWBS-DRAFT-MR67PKBQ
- SCWBS-DRAFT-MR7PVFWR
- SCWBS-DRAFT-MR7R46OO
- SCWBS-DRAFT-MR7RFNZS
- SCWBS-DRAFT-MR7RR147
- SCWBS-DRAFT-MR7S032T
- SCWBS-DRAFT-MR8IBVF7
- SCWBS-DRAFT-MR8J27M8

この group は `node-governance-maintenance` が `inProgress` で、複数 Task Contract が同じ node に属している。個別 candidate をそのまま completion apply するのではなく、専用の node-level completion task を作り、対象 Task の Evidence / Review / Approval 状態を確認してから node readiness と completion を進める。

lead model が担当する判断:

- 既存 governance maintenance candidate を完了対象に含める範囲
- `inProgress -> ready -> completed` の分割粒度
- Core revision backlog との親子関係に矛盾がないか

mini agent に渡せる作業:

- contractLock 欠落の metadata backfill
- Evidence の `testQuality` 欠落補完
- Review request record の不足確認と request record 作成
- `review-queue` / `health` 出力の更新確認

### 2. M2 は metadata-only finish workflow を先に安定化する

対象 node: `node-core-evidence-diff-guard-completion`

代表候補:

- SCWBS-CORE-M2
- SCWBS-CORE-M2-GATE
- SCWBS-CORE-M2-HEALTH
- SCWBS-DRAFT-MR7XMGQ2
- SCWBS-DRAFT-MR84NCDI
- SCWBS-DRAFT-MR8H6KXW

この group は node status が `planned` で、shared node の completion prerequisites も残っている。`SCWBS-DRAFT-MR8H6KXW` は metadata-only finish workflow optimization の plan なので、まずこの plan に沿って低コスト化できる metadata-only finish の follow-up を小さく切る。

lead model が担当する判断:

- `finish` / review request / registry rebuild / check-diff の統合範囲
- Evidence の `subjectHeadCommit` / `diffHash` を揺らさない設計
- managed contract paths と human gate の境界

mini agent に渡せる作業:

- 既存 M2 candidate の Evidence / Review / PR metadata の一覧化
- health warning の有無確認
- docs backlog と Task Contract の単純な整合チェック

### 3. MVP closeout は最後に扱う

対象 node: `node-core-mvp-closeout`

代表候補:

- SCWBS-DRAFT-MR87T1D4
- SCWBS-DRAFT-MR8GC6KT

MVP closeout は M1/M2 など子 milestone の状態に依存する。先に closeout node を完了させると、下位 milestone の completion review が残ったまま Done を装うリスクがある。MVP closeout は M2 と governance maintenance の blocker が減ってから扱う。

mini agent に渡せる作業:

- closeout Evidence の stale / missing metadata 確認
- child milestone の blocked reason 集計

## 直近の delegation 候補

低コスト agent に渡しやすい順:

1. `health.task.contractLock.missing` の backfill
   - 対象: SCWBS-CORE-M1, SCWBS-DRAFT-MR7R46OO, SCWBS-DRAFT-MR7RFNZS, SCWBS-DRAFT-MR7RR147, SCWBS-DRAFT-MR7S032T
   - 性質: metadata-only
   - 注意: 専用 Task Contract を切り、allowedPaths を対象 Task/Evidence/registry に限定する。

2. `review-queue` の no review request warning 解消
   - 対象: SCWBS-DRAFT-MR8IBVF7, SCWBS-DRAFT-MR8J27M8
   - 性質: Review record / Evidence metadata backfill
   - 注意: Approval を勝手に approved にしない。必要なら request record まで。

3. M2 candidate metadata inventory
   - 対象: SCWBS-CORE-M2, SCWBS-CORE-M2-GATE, SCWBS-CORE-M2-HEALTH, SCWBS-DRAFT-MR7XMGQ2, SCWBS-DRAFT-MR84NCDI, SCWBS-DRAFT-MR8H6KXW
   - 性質: read-only または docs-only
   - 注意: completion apply は lead model が判断する。

## lead model に残す判断

- shared node を dedicated completion task で閉じる範囲
- WBS node を `ready` にしてよいかの evidence sufficiency 判断
- Core revision backlog の milestone 間依存
- `finish` workflow の設計変更
- humanGateRequiredPaths や package / CI 設定に触れる判断

## 完了判定

この planning task の完了条件:

- この文書が current review-queue blockers を分類している。
- mini agent に渡す低リスク task と lead model に残す判断が分離されている。
- Evidence / check-diff / registry check が通る。

