# SC-WBS Operations Profile, Subtree Phase, And Spec Files

Source: docs/sc-wbs-development.md split reference.

## 15. 運用プロファイル

運用の厳格さはプロジェクトに応じて選ぶ。

| Profile | 用途 | 必須 |
|---|---|---|
| Lean | 個人開発、プロトタイプ | Task Contract、最低限Evidence、path制約 |
| Standard | 通常の業務アプリ | WBS-JSON、Task Contract、Evidence、Human Gate、`scwbs check` |
| Strict | 個人情報、金融、行政、基幹業務 | Standardに加えて承認ログ、Traceability、Risk Register、監査ログ |

プロファイルを明示しない場合はStandardを適用する。

---

## 16. 中核原則

SC-WBS Developmentの中核原則は以下である。

```text
仕様でAIを制御する。
WBS-JSONで作業構造を制御する。
Task Contractで作業範囲を制御する。
scwbs checkで契約違反を検出する。
scwbs healthで契約の鮮度と証跡の信頼性を検出する。
Evidenceで完了判定を制御する。
Human Gateで責任ある判断を制御する。
```

ツールは「正しい仕様」を自動で判断しない。

ツールが検出するのは、古くなった可能性、承認が必要な可能性、整合していない箇所である。

最終判断は人間が行う。

次段階の正式候補は以下である。

* Spec Contractに `status`、`version`、`approvedBy`、`approvedAt` を持たせる
* Spec Change Proposalの形式を定義する
* Strict Profile向けにRisk Registerの形式を定義する

## 17. Subtree Phase

Bootstrapから通常運用への移行は、プロジェクト全体ではなくWBS subtree単位で扱ってよい。

subtreeのphaseは `nodes[].extensions.scwbs.phase` に記録する。

値は以下である。

* `bootstrap`
* `normal`

## 18. Spec Contract Files

Spec Contract files live under `contracts/specs/*.yaml`.
Approved Spec Contracts must include `status`, `version`, `approvedBy`, and `approvedAt`.

### Approval Record 補足

Human approval record は `contracts/approvals/*.yaml` に置く。
最小形式は次のとおり。

```yaml
id: APR-WBS-001-004
type: approval
taskId: WBS-001-004
status: requested
pullRequest: "#42"
notes:
  - Awaiting human gate review
```

`status` は `requested`、`approved`、`rejected` のいずれかを取る。
`status: approved` の場合は `approvedBy` と `approvedAt` を必須にする。
`scwbs review-queue` は `approvalStatus` を表示でき、Evidence に `pullRequest` がない場合は approval record 側の `pullRequest` を再利用できる。
AI や実装者が review 依頼を残すだけなら、`requested` の record を生成する。
```bash
npm run scwbs -- approval request --task WBS-001-004 --pull-request "#42" --note "Awaiting human review"
```
`--note` は複数語を含む引用付き引数でも、`--note=Awaiting human review` のような inline 形式でも受け付ける。

AI Work Packet生成時は、対象nodeから親方向へたどり、最初に見つかったphaseを採用する。
対象nodeにも祖先nodeにもphaseがない場合は `unspecified` と表示する。
