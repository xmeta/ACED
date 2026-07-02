# SC-WBS Evidence, Human Gate, Review, And DoD

Source: docs/sc-wbs-development.md split reference.

## 9. Evidence

Evidenceは、作業がDone条件を満たしたことを示す証跡である。

正本は以下に置く。

```text
contracts/evidence/{task-id}.yaml
```

最小形式は以下である。

```yaml
id: EVD-001-004
type: evidence
taskId: WBS-001-004
commit: abc1234
git:
  branch: task/WBS-001-004-api-implementation
  base: main
  baseCommit: def5678
  headCommit: abc1234
  changedFilesBasis: branch-diff
  pullRequest: "#42"
changedFiles:
  - src/features/staff-search/api.ts
checks:
  - name: test
    status: passed
  - name: typecheck
    status: passed
  - name: lint
    status: passed
testQuality:
  assertionsAdded: true
  testsDisabled: false
  coverageDecreased: false
  notes:
    - staff search APIの正常系と権限エラー系を検証
notes:
  - DBスキーマ変更なし
  - 認証処理変更なし
```

Evidenceは自己申告だけで完結させない。可能な限り、CIログ、テスト結果、コミットID、差分、レビュー結果と結びつける。

現行の `scwbs evidence collect` は、`commit`、`git.branch`、`git.base`、`git.baseCommit`、`git.headCommit`、`git.changedFilesBasis`、`changedFiles`、required checksのローカル実行結果を生成する。既定の差分基準は `origin/main...HEAD` のbranch diffであり、`--base <ref>` で基準refを変更できる。`changedFiles` が作業ツリー差分ではなくPR review向けのbase/head差分であることを示すため、`git.changedFilesBasis: branch-diff` を記録する。

PR作成後は `--pull-request "#42"` を付けてEvidenceを再収集し、`git.pullRequest` を記録する。既存Evidenceを `--force` で再収集する場合、明示的な置換値がなければ既存の `git.pullRequest` は保持される。

Evidenceの信頼度は以下に分ける。

| Level | 意味 |
|---|---|
| Level A | CIから自動取得された証跡 |
| Level B | ローカル実行ログ付き証跡 |
| Level C | AIまたは人間の手入力 |

Evidenceのcheckには、可能な限り `source`、`runId`、`url`、`command`、`executedAt`、`verifiedBy` を記録する。

```yaml
checks:
  - name: test
    status: passed
    source: ci
    runId: github-actions-123456
    url: https://example.com/runs/123456
    verifiedBy: scwbs
  - name: typecheck
    status: passed
    source: local
    command: npm run typecheck
    executedAt: 2026-06-27T10:00:00+09:00
    verifiedBy: human
testQuality:
  assertionsAdded: true
  testsDisabled: false
  coverageDecreased: false
```

Standard ProfileではLevel AまたはLevel Bを推奨する。Strict ProfileではLevel Aを必須とする。

---

## 10. Human Gate

Human Gateは、人間の承認が必要な判断である。

以下は必ずHuman Gateを必要とする。

* 要求変更
* 仕様変更
* 業務ルール変更
* DBスキーマ変更
* マイグレーション追加
* APIの破壊的変更
* 認証方式の変更
* 権限設計の変更
* 個人情報の扱いに関する変更
* セキュリティ設定変更
* 外部サービス連携
* 課金・決済関連
* リリース判断
* スコープ変更
* 納期に影響する変更

承認記録は以下に置く。

```text
contracts/approvals/
```

Human Gateが必要な変更をAIが検出した場合、AIは実装せず、承認要求を作成する。
Human Gateが必要なため実装を停止する場合、AIは対象WBS nodeをblockedへ移行するchange setを提案し、承認要求を作成する。
AIは承認待ちのタスクを勝手に進めてはならない。

```bash
npm run scwbs -- ai block --task WBS-001-004 --reason "Human Gate required"
```

---

## 11. 仕様変更レベル

仕様変更は3段階に分ける。

| Level | 意味 | AIの扱い |
|---|---|---|
| Level 0 | 実装上の軽微な補完 | AIが判断してよい。Task NotesまたはEvidenceに記録する |
| Level 1 | 小さな仕様補足 | AIが提案して実装してよい。Reviewで人間が確認する |
| Level 2 | 仕様変更 | AIは停止し、人間承認を待つ |

Level 2の例:

* 業務ルール変更
* DBスキーマ変更
* API変更
* 権限変更
* セキュリティ変更
* 個人情報の扱い変更
* 画面フロー変更
* スコープ変更

`humanGateRequiredPaths` に触れる変更、または10章のHuman Gate対象に該当する変更は、Level 0またはLevel 1に見えてもHuman Gateを優先する。

判定ルールは以下である。

| Level | 判定条件 |
|---|---|
| Level 0 | 既存Specの範囲内で一意に決まり、ユーザー影響、API変更、DB変更、権限変更、業務判断がない |
| Level 1 | 既存Specの意図に沿う小さな補足で、API互換性を壊さず、Reviewで差し戻し可能である |
| Level 2 | ユーザー体験、業務ルール、API、DB、権限、セキュリティに関係する、または既存Specから一意に導けない |

仕様変更レベルの判断に迷う場合は、必ずLevel 2として扱う。

---

## 12. Review

レビューでは、コード品質だけでなく、契約違反を確認する。

確認項目:

* Spec Contractに準拠しているか
* Task Contractの範囲外の変更がないか
* 業務ルールに反していないか
* DBスキーマを勝手に変更していないか
* 認証・権限に問題がないか
* 個人情報をログ出力していないか
* テストが十分か
* Evidenceが揃っているか
* WBS状態が正しいか
* Human Gate漏れがないか

Single Session Modeで同じAIが実装とレビューを行う場合、レビューの独立性は弱い。

Review Profileは以下に分ける。

| Profile | 意味 |
|---|---|
| Self Review | 同一AIによる簡易レビュー。Leanでのみ許可する |
| Independent AI Review | 別セッション、別モデル、または別プロンプトによるレビュー。Standardの最低条件とする |
| Human Review | 人間によるレビュー。Human Gate対象またはStrictで必須とする |

Review Agentは以下を守る。

```text
直前の実装を正当化してはいけない。
Spec Contract、Task Contract、Acceptance CriteriaのみをGround Truthとして判断する。
実装者の説明をGround Truthにしてはいけない。
疑わしい場合はApproveせず、Request ChangesまたはNeeds Human Decisionとする。
```

---

## 13. Definition of Done

Doneは、コードが動いたことではない。

本プロジェクトの標準Definition of Doneは以下である。

* WBS nodeが完了可能な状態である
* Task Contractを満たしている
* Out of Scopeの作業をしていない
* `allowedPaths` 外の変更がない
* `forbiddenPaths` への変更がない
* 必要なテストが通っている
* テストコードを変更した場合、検証意図を持つassertion、expect、snapshot、fixture検証、または同等の確認が含まれている
* 既存テストを削除、skip化、コメントアウト、弱体化していない。ただし、仕様変更に伴う削除はHuman GateまたはReviewで理由が承認されている
* テストカバレッジを採用しているプロジェクトでは、対象範囲のカバレッジが低下していない
* 型チェックが通っている
* ビルドが通っている
* Evidenceが記録されている
* 必要なレビューが完了している
* 必要なHuman Gateが完了している
* 仕様変更がある場合、Spec Contractが更新されている
* 設計判断がある場合、ADRが更新されている
* 既存機能を壊していない
* セキュリティ上の重大な問題がない

Doneにする前に以下を実行する。

```bash
npm run scwbs -- check
npm run scwbs -- check-diff --task <task-id>
npm test
npm run typecheck
npm run build
```

Lintなど、Task Contractの `requiredChecks` に含まれる追加チェックがある場合は、それも実行する。

---

## 14. 状態管理

WBS状態の正本は `contracts/wbs/project.wbs.json` の `nodes[].status` である。

WBS-JSONの標準状態で表現できないSC-WBS固有状態は、必要に応じて `nodes[].extensions.scwbs.status` に置く。

状態遷移の原則:

| 遷移 | 更新権限 |
|---|---|
| planned → inProgress | HumanまたはImplementation Agent |
| inProgress → ready | Implementation Agent |
| ready → completed | Humanのみ |
| any → blocked | AIまたはHuman |
| blocked → planned | HumanまたはPM Agent |

AIはEvidenceと必要なレビューが揃っていないnodeをcompletedにしてはならない。
AIがStop Conditionを検出した場合、対象nodeをblockedにする変更を提案できる。
blocked化は、実装継続ではなく、承認待ち、情報不足、契約不足を明示するための状態変更である。

別タスクへ切り替えるには、以下のいずれかを満たす必要がある。

* 人間またはPM Agentが次のTask Contractを明示的に割り当てる
* Task Queueに優先順位付きで割り当て済みのTask Contractが存在する
* `scwbs ai next-task` が、planned状態、Human Gate対象パスなし、未完了dependsOnなしの候補を提示する

`scwbs ai next-task` は新規実装候補の発見に限定する。`No available planned tasks` は「planned状態の実装候補がない」という意味であり、既存Task ContractのEvidence収集、Review作成、Approval記録が不要という意味ではない。既存契約の後続作業を確認する場合は `scwbs next` を実行する。

AIは候補タスクを提示できるが、プロジェクトの優先順位を最終決定してはならない。

```bash
npm run scwbs -- ai next-task
npm run scwbs -- next
```

---
