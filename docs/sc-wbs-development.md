# SC-WBS Development

SC-WBS Development は、人間とAIが協調してソフトウェアを開発するための開発手法である。

正式名称は以下とする。

```text
AI-Collaborative Spec Contract and WBS Driven Development
```

本プロジェクトでは、この手法を `scwbs` CLI と `wjs` の WBS-JSON によって運用する。

この文書は方法論と運用ルールを定義する。CLIの具体的な使い方はルートの `README.md` を参照する。

Spec Contract files live under `contracts/specs/*.yaml`.
Minimum required fields are `id`, `type: spec-contract`, `featureId`, `title`, `status`, `version`, and `acceptanceCriteria`.
When `status: approved`, `approvedBy` and `approvedAt` are also required.
`contracts/registry.yaml` remains the index, but each `type: spec` entry must point to a Spec Contract file whose `id`, `featureId`, `status`, and `version` match the registry metadata.
---

## 1. 基本方針

SC-WBS Development の最重要ルールは以下である。

```text
AIは、契約されていない作業をしてはいけない。
```

次に重要なルールは以下である。

```text
Doneは、作業者の申告ではなくEvidenceで判断する。
```

AIは実装、調査、整理、検証、文書化を支援する。人間は目的、制約、承認、責任を管理する。

AIに最終判断を委ねてはいけない領域は以下である。

* 業務ルールの最終決定
* セキュリティ方針
* 個人情報の扱い
* 権限設計
* DBスキーマの重要変更
* API契約の破壊的変更
* 外部サービス連携方針
* 課金・決済関連
* リリース判断
* スコープ変更
* 納期・予算への影響判断

---

## 2. ツール前提の正本ルール

本プロジェクトでは、WBSをMarkdown表では管理しない。

WBSの正本は以下である。

```text
contracts/wbs/project.wbs.json
```

このファイルは `wjs/schema/wbs-json.schema.json` に準拠する。

SC-WBS固有の契約情報は、WBS-JSONとは分けて以下に置く。

```text
contracts/
  registry.yaml
  specs/
    SPEC-001.yaml
  wbs/
    project.wbs.json
  tasks/
    WBS-001-004.yaml
  evidence/
    WBS-001-004.yaml
  approvals/
```

それぞれの役割は以下である。

| ファイル | 役割 |
|---|---|
| `contracts/wbs/project.wbs.json` | WBS階層、状態、依存関係、成果物参照の正本 |
| `contracts/tasks/*.yaml` | AIが作業するためのTask Contract |
| `contracts/evidence/*.yaml` | 完了判定に使うEvidence |
| `contracts/approvals/*` | Human Gateの承認記録 |
| `contracts/registry.yaml` | 契約・成果物の索引 |
| `docs/sc-wbs-development.md` | 方法論と運用ルール |
| `README.md` | ツール利用者向け入口 |

Markdownは説明、レビュー、閲覧に使ってよい。ただし、WBS状態や依存関係についてはWBS-JSONを正とする。

---

## 3. 全体フロー

開発は以下の流れで進める。

```text
Bootstrap Contract
  ↓
Product Vision / Requirement / Spec
  ↓
WBS-JSON node
  ↓
Task Contract
  ↓
AI Work Packet
  ↓
Implementation
  ↓
Verification
  ↓
Evidence
  ↓
Review
  ↓
Human Gate
  ↓
Done
```

主要な契約成果物の役割は以下である。

| 成果物 | 役割 |
|---|---|
| Product Vision | 目的、対象ユーザー、成功条件、作らないものを定義する |
| Requirement Contract | ユーザー要求、背景、業務ルール、受け入れ条件を契約化する |
| Spec Contract | 実装可能な粒度で入力、出力、権限、正常系、異常系、Acceptance Criteriaを定義する |
| WBS-JSON node | 仕様を作業、成果物、マイルストーンへ分解し、状態と依存関係を管理する |
| Task Contract | AIが実行してよい作業範囲、変更可能パス、禁止パス、完了条件を定義する |
| Evidence | Done条件を満たしたことを示す証跡を記録する |

Human Gateは最後の確認だけではない。仕様、DB、権限、APIなどの承認が必要な変更を検出した時点で、実装前に挟む。

`scwbs` はこの流れのうち、以下を機械的に支援する。

* WBS-JSONの検証
* Task Contractの検証
* Evidenceの存在確認
* requiredChecksの確認
* allowedPaths / forbiddenPaths のGit差分検査
* Human Gate対象変更の検出
* AI Work Packet生成
* WBS状態の集計

---

## 4. Bootstrap Contract

ゼロから開始するプロジェクトでは、最初のSpec ContractやTask Contractがまだ存在しない。

そのため、DiscoveryからSpecificationまでの期間に限り、Bootstrap Contractを使う。

Bootstrap ContractでAIに許可する作業は以下に限る。

* Product Visionの草案作成
* 用語集の草案作成
* 要求のヒアリング項目作成
* Requirement Contractの草案作成
* Spec Contractの草案作成
* WBS候補の作成
* リスク、未確定事項、Human Gate候補の抽出

Bootstrap Contractでは、AIは実装してはならない。

通常運用へ移行する条件は以下である。

* Product Visionが人間に承認されている
* Requirement ContractまたはSpec Contractが人間に承認されている
* WBS-JSONに対象nodeがある
* 実装対象タスクのTask Contractがある

---

## 5. WBS-JSON運用

WBS-JSONでは、`nodes[]` がWBS階層の正本である。

SC-WBSでは主に以下を使う。

| WBS-JSON要素 | SC-WBSでの意味 |
|---|---|
| `nodes[]` | 作業、成果物、マイルストーン |
| `nodes[].status` | WBS上の状態 |
| `nodes[].outputs` | その作業が生成する成果物 |
| `relations[].dependsOn` | 依存関係 |
| `relations[].blocks` | ブロッカー関係 |
| `relations[].implementsRequirement` | 要求との関連 |
| `artifacts[]` | Spec、ADR、Evidence、ソースなどの成果物参照 |
| `resources[]` | Human、AI Agent、チーム、担当ロール |
| `extensions.scwbs` | SC-WBS固有の補足情報 |

WBSを変更するとき、AIは原則としてWBS全体を再生成してはならない。

AIがWBS変更を提案する場合は、`wjs` のsemantic operationsを使い、`dryRun: true` のchange setとして提出する。

例:

```json
{
  "schemaVersion": "0.1.0",
  "targetWbsId": "scwbs-project",
  "changeSetId": "changeset-add-api-task",
  "author": "ai-agent",
  "reason": "Add API implementation task",
  "dryRun": true,
  "operations": [
    {
      "operation": "addNode",
      "node": {
        "id": "node-api-implementation",
        "parentId": "node-project",
        "code": "1.1",
        "name": "API Implementation",
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

変更内容を確認するには以下を実行する。

```bash
npm run scwbs -- wbs apply change-set.json
```

`dryRun: true` のchange setは、結果を確認するためのプレビューとして扱う。

実際に書き込む場合のみ、Human Gateを通したうえで明示的に `--force --output contracts/wbs/project.wbs.json` を使う。

---

## 6. Task Contract

Task Contractは、AIが実装する1作業単位に対する契約である。
1つのTask Contractは、原則として1つのWBS nodeに対応させる。

正本は以下に置く。

```text
contracts/tasks/{task-id}.yaml
```

最小形式は以下である。

```yaml
id: WBS-001-004
type: task-contract
wbsNodeId: node-api-implementation
featureId: F001
branchName: task/WBS-001-004-api-implementation
allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**
forbiddenPaths:
  - src/auth/**
  - src/database/schema/**
  - migrations/**
humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
  - openapi/**
requiredChecks:
  - test
  - typecheck
  - lint
doneCriteria:
  - Spec Contractを満たしている
  - 正常系と異常系のテストが通る
evidenceRequired:
  - test-result
  - typecheck-result
  - lint-result
contractLock:
  wbsRevision: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  wbsNodeId: node-api-implementation
  specVersion: 1.2.0
  specRevision: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
  createdAt: 2026-06-27T10:00:00+09:00
```

`wbsNodeId` は `contracts/wbs/project.wbs.json` の `nodes[].id` を指す。
Task Contractは、生成時点のWBS content hashとSpec versionを `contractLock` として記録する。
AI Work Packet生成時および `scwbs check` では、`contractLock` と現在のWBS-JSON、Spec Contractの鮮度を比較する。
WBS nodeのID、親子関係、依存関係、outputs、または参照SpecのversionがTask Contract生成時点から変更されている場合、そのTask Contractはstaleとして扱う。
staleなTask Contractに基づいてAIは実装してはならない。実装前にTask Contractを再生成するか、人間の承認を受けてlockを更新する。
Task Contractのlockを生成するには以下を実行する。

```bash
npm run scwbs -- task lock --task WBS-001-004
```

`allowedPaths` は変更してよい最大範囲であり、変更すべき範囲ではない。
`forbiddenPaths` と `humanGateRequiredPaths` は `allowedPaths` より優先する。

AIはTask Contractの範囲外を変更してはならない。範囲外変更が必要な場合は、実装を止めてSpec Change ProposalまたはHuman Gateを要求する。

Task Contractの推奨粒度は以下である。

* 1つのPRで完了できる
* 1つの主要成果物に対応する
* `allowedPaths` が3〜5グループ以内である
* Stop Conditionsを明確に判定できる
* 人間が15分〜30分でレビューできる差分である

危険領域に触る作業は分離する。UI変更、API変更、DB変更、権限変更、マイグレーション追加を1つのTask Contractに混ぜてはならない。

WBS nodeからTask Contract草案を生成するには以下を実行する。

```bash
npm run scwbs -- task generate --node node-api-implementation --task WBS-001-004
```

生成されたTask Contractは草案である。人間が `allowedPaths`、`humanGateRequiredPaths`、`doneCriteria` を確認し、必要に応じて修正してから `task lock` を実行する。

---

## 7. AI Work Packet

AIに実装を依頼するときは、長い文書一式をそのまま読ませるのではなく、`scwbs` でAI Work Packetを生成する。

```bash
npm run scwbs -- ai packet --task WBS-001-004 --relation-depth 1
```

AI Work Packetには以下を含める。

* AIの役割
* 対象Task Contract
* 対応WBS node
* 関連relations
* outputs artifacts
* requiredChecks
* allowedPaths
* forbiddenPaths
* humanGateRequiredPaths
* Stop Conditions

AIはWork Packetを作業時の優先コンテキストとして扱う。
AI Work Packetは、対象Task Contractを最優先コンテキストとし、関連情報は作業判断に必要な範囲へ絞る。
既定では、relationsの展開範囲は対象WBS nodeからdepth=1までとする。
depth=1には、親node、直接の子node、直接dependsOn、直接blocks、同一親配下の直近の兄弟nodeを含める。
depth=2以上の展開は、Task ContractまたはCLI引数で明示された場合のみ許可する。
Work Packetが大きくなる場合、`scwbs` は本文全体を含めるのではなく、要約、artifact参照、または該当箇所へのパスを優先する。
AIが追加コンテキストを必要と判断した場合は、実装前に不足コンテキストを明示して要求する。

Stop Conditionsに該当する場合、AIは実装せずに停止する。

代表的なStop Conditions:

* DBスキーマ変更が必要
* 認証・権限変更が必要
* API契約の破壊的変更が必要
* Business Ruleが不足している
* allowedPaths外の変更が必要

---

## 8. Contract Enforcement

`scwbs check` は、SC-WBSの契約違反を検出する。

```bash
npm run scwbs -- check
```

検出対象は以下である。

* WBS-JSONが不正
* registryの参照先が存在しない
* Task Contractの `wbsNodeId` がWBS nodeに存在しない
* Task Contractの `contractLock` が現在のWBS revisionまたはSpec versionと整合していない
* WBS nodeの `outputs` が存在しないartifactを指している
* Done相当nodeにEvidenceがない
* EvidenceにrequiredChecksがない
* Human Gate対象変更に承認記録がない

Git差分はTask単位で検査する。

```bash
npm run scwbs -- check-diff --task WBS-001-004
```

判定ルール:

| 条件 | 結果 |
|---|---|
| `allowedPaths` 外の変更 | Error |
| `forbiddenPaths` への変更 | Error |
| `humanGateRequiredPaths` への変更 | WarningまたはHuman Gate要求 |
| 明示許可されていないメタファイル変更 | Error |

CIでは、Errorがある場合にPRを通してはならない。

メタファイルは、AIがpath制約や検証環境を迂回するために変更できるため、既定で強い制約を受ける。
代表例は以下である。

* `package.json`
* `package-lock.json`
* `tsconfig.json`
* `vitest.config.ts`
* `.gitignore`
* `.github/**`

これらを変更するTask Contractは、対象ファイルを `allowedPaths` または `humanGateRequiredPaths` に明示しなければならない。
明示されていない場合、`scwbs check-diff` はErrorとして扱う。

`scwbs health` は、契約ファイルと実装のdriftを検出する。

```bash
npm run scwbs -- health
```

`scwbs check` が構文、参照、存在確認を扱うのに対し、`scwbs health` は運用健全性を扱う。代表的な検出対象は以下である。

* Evidenceの信頼度が低い
* Evidenceのcommitが欠けている、またはGitで確認できない
* EvidenceのchangedFilesがTask Contractのpath制約と整合していない
* Human Gate対象のEvidenceに承認記録がない
* registry上のRequirement ContractやSpec Contractにstatusがない
* Spec Contractにversion相当の情報がない
* Task Contractに `contractLock` がない
* テストファイルの差分で、assertion、expect、snapshot、fixture検証などの検証要素が確認できない
* 既存テストがskip化、コメントアウト、または削除されているが、Evidenceまたは承認記録に理由がない
* coverage summaryが存在する場合に、対象範囲のカバレッジが低下している

---

Review待ち候補を一覧するには `scwbs review-queue` を使う。
```bash
npm run scwbs -- review-queue
```

このコマンドは少なくとも次を候補として表示する。
* Evidence が存在し、依存が完了していれば human review に進める task
* Evidence が存在するが、未完了の dependsOn があるため completed に進めない task
* Human Gate 対象 path を Evidence が変更しているのに approval 記録がない task
* Task Contract または Evidence に branch / PR 情報がある場合、その情報
* review に必要な branch / PR 情報が不足している場合、その warning
* taskごとの `suggestedAction`
* review候補数、依存block数、PR metadata不足数などの簡易summary

Task Contractごとにbranchを分ける運用では、`1 Task Contract = 1 branch = 1 review unit` を基本とする。

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
  headCommit: abc1234
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

AIは候補タスクを提示できるが、プロジェクトの優先順位を最終決定してはならない。

```bash
npm run scwbs -- ai next-task
```

---

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
