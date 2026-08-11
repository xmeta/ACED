# SC-WBS Operations Profile, Subtree Phase, And Spec Files

Source: docs/sc-wbs-development.md split reference.

## 15. 運用プロファイル

運用の厳格さはプロジェクトに応じて選ぶ。

| Profile | 用途 | 方法論上の要求 | 現行 `init` が作成するartifact directory |
|---|---|---|---|
| Lean | 個人開発、プロトタイプ | Task Contract、Evidence、path制約 | `contracts/tasks/`, `contracts/evidence/`, `contracts/approvals/`, `contracts/changesets/`, `contracts/wbs/` |
| Standard | 通常の業務アプリ | WBS-JSON、Task Contract、Evidence、Human Gate、`scwbs check` | Lean + `contracts/reviews/` |
| Strict | 個人情報、金融、行政、基幹業務 | Standardに加えて承認ログ、Traceability、Risk Register、監査ログ | Standard + `contracts/specs/`, `contracts/spec-changes/` |

プロファイルを明示しない場合はStandardを適用する。

上表の「方法論上の要求」と「現行CLIが機械的に強制する範囲」は同一ではない。Strictは `contracts/specs/` と `contracts/spec-changes/` を追加し、LeanではSpec/Spec Changeのrepository-wide検証を省略する。Risk Register v1 は `contracts/risks/` の `scwbs.risk.v1` artifact、固定スコア、Strictの未処理High/Critical検出、Evidence subject/diffに束縛されたHuman受入れ鮮度を検証する。監査ログとProfile別Review種別の強制は別スコープである。`contracts/reviews/` のrecordはTask別のreview/completion flowで検証されるが、`scwbs check` が全Review recordをProfile別に列挙して強制するわけではない。

したがって `init --profile strict` や `profile set strict` の表示だけを、監査ログやHuman Reviewまで完備した証明として扱ってはならない。Risk Registerの受入れはCLIからもHuman-onlyであり、AIの判断やRisk artifactだけをTask完了・Approvalの根拠にはできない。

AI Work Packet にはプロファイル情報とアクティブなアーティファクトディレクトリ一覧が含まれる。

外部 attestation は `scwbs.attestation-verification.v1` の bounded summary として Evidence に記録できる。検証は指定された artifact digest、repository、signer workflow、predicate、source commit/ref に束縛し、missing / invalid / subject-mismatch / untrusted / unavailable を区別する。attestation 本文、秘密鍵、token、trusted root は保存・自動採用しない。workflow の `id-token` / `attestations` 権限、issuer/trust-root の採用、fork/untrusted PR の署名境界、release 公開は Human Gate の対象である。

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


## 17. Subtree Phase

Bootstrapから通常運用への移行は、プロジェクト全体ではなくWBS subtree単位で扱ってよい。

subtreeのphaseは `nodes[].extensions.scwbs.phase` に記録する。

値は以下である。

* `bootstrap`
* `normal`

## 18. Spec Contract Files

Spec Contract files live under `contracts/specs/*.yaml`.
Approved Spec Contracts must include `status`, `version`, `approvedBy`, and `approvedAt`.

## 19. Spec Change Proposal Files

Spec Change Proposal files live under `contracts/spec-changes/*.yaml`.
They describe proposed Level 1 or Level 2 changes before the approved Spec Contract is updated.

Minimum form:

```yaml
id: SCP-SCWBS-001
type: spec-change-proposal
status: proposed
targetSpec: SPEC-SCWBS-METHOD
currentVersion: 0.1.0
proposedVersion: 0.2.0
taskId: SCWBS-041
level: 2
summary: Define a new contract artifact.
rationale:
  - The current approved spec does not define the changed behavior.
affectedPaths:
  - docs/scwbs/operations-profile-and-specs.md
approval:
  required: true
  status: requested
risks:
  - Existing task locks may need refresh after approval.
```

`status` is one of:

| Status | Meaning |
|---|---|
| `proposed` | Proposed and not yet approved |
| `approved` | Human-approved and ready to drive Spec Contract updates |
| `rejected` | Not accepted |
| `superseded` | Replaced by another proposal |

When `status: approved`, `approvedBy` and `approvedAt` are required.
`scwbs check` validates Spec Change Proposal files and requires them to be indexed by `contracts/registry.yaml`.

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
Human が Evidence と PR を確認して承認する場合は、YAML を手書きせずに `approved` record を生成できる。
```bash
npm run scwbs -- approval approve --task WBS-001-004 --pull-request "#42" --actor human --reason "Evidence and PR reviewed"
```
複数の review-ready task を completed に進める場合は、まず dry-run で対象nodeと生成される changeset を確認し、明示的に `--apply` する。
```bash
npm run scwbs -- completion apply --tasks WBS-001-004,WBS-001-005 --task WBS-001-999 --reason "Reviewed and accepted"
npm run scwbs -- completion apply --tasks WBS-001-004,WBS-001-005 --task WBS-001-999 --reason "Reviewed and accepted" --apply
```
`completion apply` は root node completion を既定で拒否する。プロジェクト全体の完了など broad な判断だけは、明示的な Human decision と `--allow-root` を必要とする。
`--note` と `--reason` は複数語を含む引用付き引数でも、`--note=Awaiting human review` のような inline 形式でも受け付ける。

AI Work Packet生成時は、対象nodeから親方向へたどり、最初に見つかったphaseを採用する。
対象nodeにも祖先nodeにもphaseがない場合は `unspecified` と表示する。
