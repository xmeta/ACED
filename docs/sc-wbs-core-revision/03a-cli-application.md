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
