# 03. Detailed Design

この文書は、SC-WBS Core改訂の詳細設計である。

## 全体アーキテクチャ

SC-WBS Core は、以下の層に分ける。

```text
CLI Layer
  ↓
Application Service Layer
  ↓
Domain Service Layer
  ↓
Repository / File System Layer
  ↓
Git / Process Adapter Layer
```

## 設計原則

```text
- CLIは薄くする。
- YAML/JSONの読み書きはRepositoryに閉じ込める。
- Git操作はAdapterに閉じ込める。
- 検証ロジックはDomain Serviceに集める。
- AI向け出力は短く、機械向け出力は構造化する。
```

## モジュール構成案

```text
src/
  cli/
    index.ts
    commands/
      task-new.ts
      start.ts
      packet.ts
      finish.ts
      check-diff.ts
      block.ts
      approval.ts
      next.ts
      fix.ts
  app/
    task-service.ts
    packet-service.ts
    finish-service.ts
    validation-service.ts
    approval-service.ts
    block-service.ts
    next-service.ts
  domain/
    task-contract.ts
    evidence.ts
    approval.ts
    block.ts
    packet.ts
    check.ts
    path-rules.ts
    diff-hash.ts
    stop-condition.ts
  repositories/
    task-repository.ts
    evidence-repository.ts
    approval-repository.ts
    block-repository.ts
    config-repository.ts
    wbs-repository.ts
  adapters/
    git-adapter.ts
    process-runner.ts
    glob-matcher.ts
    clock.ts
    id-generator.ts
  schemas/
    task-contract.schema.json
    evidence.schema.json
    approval.schema.json
    block.schema.json
    config.schema.json
  output/
    human-output.ts
    json-output.ts
    ai-packet-output.ts
```

## CLI Layer

CLI Layerは、以下だけを担当する。

```text
- 引数解析
- 対話式入力
- Application Service呼び出し
- 出力形式の選択
- exit code制御
```

CLI Layerに以下を置いてはいけない。

```text
- path制約判定
- Evidence生成ロジック
- Approval scope検証
- Git diff解析
- YAML構築の詳細
```

## Application Service Layer

ユースケース単位の処理を担当する。

### TaskService

責務:

```text
- Task Contract生成
- taskId採番
- branchName生成
- task lock生成/更新
- tasks index更新
```

主要メソッド:

```ts
createTask(input: CreateTaskInput): Promise<CreateTaskResult>
lockTask(taskId: string): Promise<TaskContract>
refreshTask(taskId: string): Promise<TaskContract>
```

### PacketService

責務:

```text
- Tiny / Normal / Deep Packet生成
- AI向け出力の短縮
- 追加コンテキストの参照だけを含める
```

主要メソッド:

```ts
generatePacket(input: GeneratePacketInput): Promise<Packet>
```

### FinishService

責務:

```text
- requiredChecks実行
- changedFiles収集
- diffHash生成
- Evidence生成
- check-diff実行
- 次アクション提示
```

主要メソッド:

```ts
finish(input: FinishInput): Promise<FinishResult>
```

### ValidationService

責務:

```text
- check-diffの実体
- path制約検証
- managedContractPaths検証
- humanGateRequiredPaths検証
- Evidence検証
- Approval scope検証
- WBS changeset再現性検証
```

主要メソッド:

```ts
checkDiff(input: CheckDiffInput): Promise<CheckReport>
```

### ApprovalService

責務:

```text
- approval requested生成
- approval approved生成
- approval scope検証
- 古いapprovalのstale判定
```

主要メソッド:

```ts
requestApproval(input: RequestApprovalInput): Promise<ApprovalRecord>
approve(input: ApproveInput): Promise<ApprovalRecord>
validateApprovalScope(input: ApprovalScopeInput): Promise<ApprovalScopeStatus>
```

### BlockService

責務:

```text
- block record生成
- stop condition分類
- approval request draft生成
- spec change proposal draft生成候補
```

主要メソッド:

```ts
block(input: BlockInput): Promise<BlockResult>
```

### NextService

責務:

```text
- 次に必要な行動の優先順位付け
- fixCommand提示
- AIが迷わない短い出力
```

主要メソッド:

```ts
next(input: NextInput): Promise<NextAction[]>
```

## Domain Model

### TaskContract

AIが実行してよい範囲を表す。

最小概念:

```text
id
title
goal
branchName
allowedPaths
forbiddenPaths
humanGateRequiredPaths
stopIf
checks
lock
```

### Evidence

作業差分がチェックを満たしたことを表す。

重要なのは、Evidence自身のコミットではなく、検証対象差分を指すこと。

```text
subjectHeadCommit
baseCommit
diffHash
changedFiles
checks
```

### Approval

人間承認を表す。

Approvalは、単なるタスクIDではなく、承認対象scopeに紐づく。

```text
status
approvedBy
approvedAt
scope.headCommit
scope.diffHash
```

### Block

AIまたは人間が、作業を止める理由を表す。

```text
reason
kind
stopCondition
requestedDecision
```

### Packet

AIに渡す作業カード。

Tiny Packetは短いテキスト出力を第一形式とする。

## Repository Layer

YAML/JSONの読み書きを担当する。

```text
contracts/tasks/*.yaml
contracts/evidence/*.yaml
contracts/approvals/*.yaml
contracts/blocks/*.yaml
contracts/tasks/index.yaml
contracts/wbs/project.wbs.json
contracts/changesets/*.json
```

Repositoryは以下を守る。

```text
- 既存ファイルを暗黙に上書きしない。
- 書き込み前にschema validationを行う。
- 可能ならatomic writeする。
- 生成物にはformatを統一する。
```

## Git Adapter

Git操作は直接CLI各所に散らさない。

責務:

```text
- 現在branch取得
- base ref解決
- head commit取得
- changed files取得
- diff内容取得
- diffHash生成に必要な正規化diff取得
- branch名検証
```

主要メソッド:

```ts
getCurrentBranch(): Promise<string>
getHeadCommit(): Promise<string>
getBaseCommit(baseRef: string): Promise<string>
getChangedFiles(baseRef: string, headRef: string): Promise<ChangedFile[]>
getNormalizedDiff(baseRef: string, headRef: string): Promise<string>
```

## Process Runner

requiredChecksを実行する。

責務:

```text
- command実行
- timeout
- stdout/stderr収集
- exit code記録
- CI/local source判定
```

Check Catalogに基づいて実行する。

```yaml
checks:
  test:
    command: npm test
    timeoutSeconds: 300
  typecheck:
    command: npm run typecheck
    timeoutSeconds: 300
```

## 出力設計

### Human output

人間向けには短く表示する。

```text
ERROR SCWBS_PATH_FORBIDDEN
Task: WBS-001
File: migrations/001_add_table.sql
Reason: forbiddenPaths matched migrations/**
Fix:
  scwbs block "DB migration is required"
```

### JSON output

CIやAI統合向けに `--json` を用意する。

```json
{
  "ok": false,
  "errors": [
    {
      "code": "SCWBS_PATH_FORBIDDEN",
      "taskId": "WBS-001",
      "file": "migrations/001_add_table.sql",
      "fixCommand": "scwbs block \"DB migration is required\""
    }
  ]
}
```

### AI Packet output

AI Packetは、読みやすい短いテキストを第一形式とする。

```text
Task: WBS-001 - Staff search API
Goal: Implement staff search API.

Allowed:
- src/features/staff-search/**
- tests/features/staff-search/**

Do not touch:
- src/auth/**
- migrations/**

Stop if:
- DB schema change needed
- auth/permission change needed
- API breaking change needed

When done:
- scwbs finish

When blocked:
- scwbs block "<reason>"
```

## Error Code設計

代表的なエラーコード:

| Code | 意味 | 代表fixCommand |
|---|---|---|
| `SCWBS_TASK_NOT_FOUND` | Task Contractがない | `scwbs task new` |
| `SCWBS_BRANCH_MISMATCH` | branchがTask Contractと違う | `scwbs start <task-id>` |
| `SCWBS_PATH_OUTSIDE_ALLOWED` | allowedPaths外変更 | 変更を戻す、または `scwbs block` |
| `SCWBS_PATH_FORBIDDEN` | forbiddenPaths変更 | `scwbs block "..."` |
| `SCWBS_HUMAN_GATE_REQUIRED` | Human Gate対象差分 | `scwbs request-approval <task-id>` |
| `SCWBS_EVIDENCE_MISSING` | Evidenceなし | `scwbs finish` |
| `SCWBS_APPROVAL_SCOPE_STALE` | 承認後に差分変更 | `scwbs approve <task-id> --pr <n>` |
| `SCWBS_CHECK_FAILED` | required check失敗 | テスト修正後 `scwbs finish` |

## 状態遷移

Coreでは状態を単純にする。

```text
planned -> inProgress -> ready -> completed
                 ↓
              blocked
```

AIができること:

```text
planned -> inProgress
inProgress -> ready
any -> blocked
```

人間が必要なこと:

```text
ready -> completed
blocked -> planned
approval requested -> approved
```

## セキュリティ境界

AIが実行してよいコマンド:

```text
scwbs start
scwbs packet
scwbs finish
scwbs check-diff
scwbs block
scwbs request-approval
scwbs next
```

AIが実行してはいけないコマンド:

```text
scwbs approve
scwbs complete
scwbs release
```

実装上は、CIやローカルで完全にAI実行を区別できない場合がある。
そのため、少なくとも出力文書とAGENTS.mdで禁止し、`approve` には `--actor human` や署名・環境変数などの追加ガードを検討する。

