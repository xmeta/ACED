# 05. Data Model

この文書は、SC-WBS Coreで生成・検証する最小データモデルを定義する。

## 基本方針

```text
YAML/JSONは正本として残す。
ただし、人間やAIの入力UIにはしない。
```

人間とAIはCLIを使う。
CLIが以下のファイルを生成する。

```text
contracts/tasks/*.yaml
contracts/evidence/*.yaml
contracts/approvals/*.yaml
contracts/blocks/*.yaml
contracts/tasks/index.yaml
```

Coreでは、WBS-JSONは任意である。

### DiscoveryとDeliveryの進捗

WBS nodeは `workMode: discovery|delivery` で上流探索と反復可能なDeliveryを区別する。Discovery nodeでは `progressPercent` を使わず、`discovery` の `factsLearned`、`hypothesesRejected`、`openUnknowns`、`blockingUnknowns`、`exitConditions`、`exitConditionsMet`、`decisionReadiness`、`nextDecision` を正本にする。`decisionReadiness` は、exit conditions未達またはblocking unknownsがある場合は `notReady`、それ以外でopen unknownsが残る場合は `conditionallyReady`、残らない場合は `ready` と判定する。

既存の `contracts/discovery/*.yaml` Probeも同じ派生指標で `scwbs status --json` と `scwbs next` に表示する。これはSource本文やEvidenceの代替ではなく、次の意思決定を明示するためのboundedな状態表示である。

## ディレクトリ構成

Core最小構成:

```text
contracts/
  tasks/
    index.yaml
    WBS-001.yaml
  evidence/
    WBS-001.yaml
  approvals/
    WBS-001.yaml
  blocks/
    WBS-001.yaml
  config.yaml
```

Full連携時:

```text
contracts/
  registry.yaml
  specs/
  wbs/
    project.wbs.json
  changesets/
  reviews/
  spec-changes/
```

## `contracts/config.yaml`

Core設定。

```yaml
schemaVersion: 0.1.0
profile: core
baseRef: origin/main
idPrefix: WBS
checks:
  test:
    command: npm test
    timeoutSeconds: 300
  typecheck:
    command: npm run typecheck
    timeoutSeconds: 300
pathPolicy:
  caseSensitive: true
  normalizeSeparators: true
  managedContractPaths:
    - contracts/evidence/{taskId}.yaml
    - contracts/blocks/{taskId}.yaml
    - contracts/approvals/{taskId}.yaml
```

### 必須項目

| Field | 必須 | 説明 |
|---|---:|---|
| `schemaVersion` | yes | 設定schema version |
| `profile` | yes | `core`, `lean`, `standard`, `strict` |
| `baseRef` | yes | diff基準 |
| `checks` | no | Check Catalog |
| `pathPolicy` | no | path検証設定 |

## Task Contract

ファイル:

```text
contracts/tasks/<task-id>.yaml
```

最小形式:

```yaml
schemaVersion: 0.1.0
id: WBS-001
type: task-contract
title: スタッフ検索APIを実装
goal: スタッフ検索APIを既存仕様の範囲で実装する。
status: planned
branchName: task/WBS-001-staff-search
allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**
forbiddenPaths:
  - src/auth/**
  - src/database/**
  - migrations/**
  - package.json
humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
stopIf:
  - DB schema change is required
  - auth or permission design change is required
  - public API breaking change is required
  - allowedPaths are insufficient
checks:
  - test
  - typecheck
lock:
  taskHash: sha256:...
  specHash: sha256:...
  createdAt: 2026-07-03T10:00:00+09:00
```

### 設計ポイント

- `allowedPaths` は最大許可範囲であり、変更推奨範囲ではない。
- `forbiddenPaths` は `allowedPaths` より優先する。
- `humanGateRequiredPaths` は変更された場合にApprovalを要求する。
- `stopIf` はAIに渡すTiny Packetへそのまま出す。
- `lock` はCoreでは軽く保つ。

## tasks index

WBSなし運用で使う。

ファイル:

```text
contracts/tasks/index.yaml
```

例:

```yaml
schemaVersion: 0.1.0
tasks:
  - id: WBS-001
    status: planned
    dependsOn: []
    priority: 10
  - id: WBS-002
    status: planned
    dependsOn:
      - WBS-001
    priority: 20
```

### WBSとの関係

- WBSがない場合は `tasks/index.yaml` が軽量なタスク一覧になる。
- WBSがある場合はWBSを正本とし、indexはキャッシュまたは表示用にできる。

## Evidence

ファイル:

```text
contracts/evidence/<task-id>.yaml
```

最小形式:

```yaml
schemaVersion: 0.1.0
id: EVD-WBS-001
type: evidence
taskId: WBS-001
baseRef: origin/main
baseCommit: def5678
subjectHeadCommit: abc1234
evidenceCommit: null
diffHash: sha256:...
changedFiles:
  - src/features/staff-search/api.ts
  - tests/features/staff-search/api.test.ts
checks:
  - name: test
    status: passed
    command: npm test
    source: local
    executedAt: 2026-07-03T10:00:00+09:00
  - name: typecheck
    status: passed
    command: npm run typecheck
    source: local
    executedAt: 2026-07-03T10:00:00+09:00
testQuality:
  assertionsAdded: unknown
  testsDisabled: false
  coverageDecreased: unknown
```

### 重要な変更

`headCommit` ではなく `subjectHeadCommit` を使う。

```text
subjectHeadCommit = Evidenceが証明する実装差分のHEAD
evidenceCommit = Evidenceファイル自身がコミットされたcommit。任意
```

これにより、EvidenceファイルのコミットでEvidenceがstaleになる問題を避ける。

## Approval

ファイル:

```text
contracts/approvals/<task-id>.yaml
```

requested:

```yaml
schemaVersion: 0.1.0
id: APR-WBS-001
type: approval
taskId: WBS-001
status: requested
gateType: preImplementation
reason: DB schema change is required
requestedAt: 2026-07-03T10:00:00+09:00
requestedBy: ai
```

approved:

```yaml
schemaVersion: 0.1.0
id: APR-WBS-001
type: approval
taskId: WBS-001
status: approved
gateType: completion
reason: Evidence and PR reviewed
approvedBy: human
approvedAt: 2026-07-03T11:00:00+09:00
scope:
  pullRequest: "#42"
  headCommit: abc1234
  diffHash: sha256:...
```

### gateType

| gateType | 意味 |
|---|---|
| `preImplementation` | 実装前判断。DB/API/Auth等 |
| `completion` | 完了判断。ready -> completed |
| `release` | リリース判断 |

### 重要な制約

- AIは `status: approved` を生成してはいけない。
- `approval request` は `requested` だけを作る。
- `approve` は人間操作である。
- Approvalは `scope.headCommit` と `scope.diffHash` に紐づく。

## Block

ファイル:

```text
contracts/blocks/<task-id>.yaml
```

例:

```yaml
schemaVersion: 0.1.0
id: BLK-WBS-001
type: block
taskId: WBS-001
status: blocked
reason: DBスキーマ変更が必要
kind: db-change
level: 2
detectedBy: ai
detectedAt: 2026-07-03T10:30:00+09:00
requestedDecision:
  - staff_availability table を追加してよいか
suggestedCommand:
  - scwbs request-approval WBS-001 --reason "DB schema change is required"
```

### kind候補

```text
unknown
spec-change
db-change
api-breaking-change
auth-change
permission-change
security-change
scope-change
external-service-change
```

## Packet

Packetは正本ファイルではなく、生成出力である。

Tiny Packet例:

```text
Task: WBS-001 - スタッフ検索APIを実装
Goal: スタッフ検索APIを既存仕様の範囲で実装する。

Allowed:
- src/features/staff-search/**
- tests/features/staff-search/**

Do not touch:
- src/auth/**
- src/database/**
- migrations/**
- package.json

Stop if:
- DB schema change is required
- auth or permission design change is required
- public API breaking change is required
- allowedPaths are insufficient

Checks:
- test
- typecheck

When done:
- scwbs finish

When blocked:
- scwbs block "<reason>"
```

## managedContractPaths

EvidenceやBlockなどCLIが生成する管理ファイルは、通常の `allowedPaths` と別枠で扱う。

例:

```yaml
managedContractPaths:
  - contracts/evidence/{taskId}.yaml
  - contracts/blocks/{taskId}.yaml
  - contracts/approvals/{taskId}.yaml
```

ただし、すべて自由に変更してよいわけではない。

| File | AIが生成可 | AIがapproved化可 | 備考 |
|---|---:|---:|---|
| Evidence | yes | n/a | `finish`で生成 |
| Block | yes | n/a | `block`で生成 |
| Approval requested | yes | no | `request-approval`で生成 |
| Approval approved | no | no | 人間のみ |

## Path正規化

path検証では以下を行う。

```text
- Windowsの `\` を `/` に正規化する。
- `.` と `..` を正規化する。
- symlinkは実パス解決を検討する。
- rename/deleteもchangedFilesとして扱う。
```

## Schema version

すべての生成ファイルに `schemaVersion` を持たせる。

初期値:

```text
0.1.0
```

互換性のない変更を行う場合のみmajor相当を上げる。
