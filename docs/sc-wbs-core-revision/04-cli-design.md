# 04. CLI Design

この文書は、SC-WBS Core のCLI設計である。

## CLI設計の目的

CLIは、人間とAIの両方にとっての主要UIである。

```text
人間: YAMLを書かずにタスク作成・承認・確認を行う
AI: 短いPacketを読み、完了時/停止時に短いコマンドを実行する
CI: JSON出力を読み、PRを止める
```

## UX原則

```text
- よく使うコマンドは短くする。
- 危険操作は明示的にする。
- エラーには必ず次のコマンドを出す。
- YAML/JSONを直接編集させない。
- 既定値は安全側に倒す。
- AI向けPacketでは npm run scwbs -- ... ではなく scwbs ... と短く表示する。
```

## コマンド一覧

Coreで実装するコマンド:

```bash
scwbs next
scwbs task new "<title>"
scwbs start <task-id>
scwbs packet [--task <task-id>] [--tiny|--normal|--deep]
scwbs finish [--task <task-id>] [--pr <number>]
scwbs check-diff [--task <task-id>] [--base <ref>]
scwbs block "<reason>"
scwbs request-approval <task-id>
scwbs approve <task-id>
scwbs fix
```

## `scwbs task new`

### 目的

Task ContractをYAML直書きなしで生成する。

### 基本形

```bash
scwbs task new "スタッフ検索APIを実装"
```

### オプション

```bash
scwbs task new "スタッフ検索APIを実装" \
  --id WBS-001 \
  --paths src/features/staff-search/**,tests/features/staff-search/** \
  --forbid src/auth/**,migrations/** \
  --gate src/security/**,src/permissions/** \
  --checks test,typecheck \
  --stop db,auth,permission,breaking-api \
  --branch task/WBS-001-staff-search
```

### 引数不足時

対話式で補う。

```text
Title: スタッフ検索APIを実装
Allowed paths? src/features/staff-search/**,tests/features/staff-search/**
Checks? test,typecheck
Stop presets? db,auth,permission,breaking-api
Create WBS-001? yes
```

### 生成物

```text
contracts/tasks/<task-id>.yaml
contracts/tasks/index.yaml    # WBSなし運用の場合
```

WBSが存在する場合は、必要に応じて changeset draft を生成する。

### 禁止事項

- 既存Task Contractを暗黙に上書きしない。
- Human approvalを作らない。
- completed状態を作らない。

## `scwbs start`

### 目的

作業開始時のpre-flightを行う。

### 基本形

```bash
scwbs start WBS-001
```

### 処理

```text
1. Task Contractを読む
2. branchを確認する
3. branchがなければ作成候補を表示する
4. lock freshnessを確認する
5. allowed/forbidden/stopIf/checksを表示する
6. Tiny Packet生成コマンドを表示する
```

### 出力例

```text
Task: WBS-001 - スタッフ検索APIを実装
Branch: task/WBS-001-staff-search

Allowed:
- src/features/staff-search/**
- tests/features/staff-search/**

Stop if:
- DB schema change needed
- auth/permission change needed

Next:
  scwbs packet --task WBS-001 --tiny
```

## `scwbs packet`

### 目的

AIに渡す作業カードを生成する。

### 基本形

```bash
scwbs packet --task WBS-001 --tiny
```

`--tiny` を既定にする。

### Packet levels

| Level | 用途 | 内容 |
|---|---|---|
| tiny | 通常作業 | goal, paths, stopIf, checks, done/block commands |
| normal | 仕様確認が必要 | tiny + acceptanceCriteria + spec slice |
| deep | 設計判断が必要 | normal + 関連WBS/ADR/背景参照 |

### Tiny Packetの制約

```text
- できるだけ50行以内
- スキーマ説明を含めない
- YAMLの全内容を出さない
- 関連資料は本文ではなくパス参照にする
```

## `scwbs finish`

### 目的

完了処理を1コマンド化する。

### 基本形

```bash
scwbs finish
```

PR作成後:

```bash
scwbs finish --pr 42
```

### 処理

```text
1. taskId推定
2. Task Contract取得
3. requiredChecks実行
4. changedFiles収集
5. diffHash生成
6. Evidence生成/更新
7. check-diff実行
8. 次アクション表示
```

### 成功出力例

```text
OK: WBS-001 finish checks passed
Evidence: contracts/evidence/WBS-001.yaml
Diff hash: sha256:abc...

Next:
  Open PR and run:
  scwbs finish --pr 42
```

### 失敗出力例

```text
ERROR SCWBS_PATH_FORBIDDEN
Task: WBS-001
File: migrations/001_add_staff_table.sql
Reason: forbiddenPaths matched migrations/**
Fix:
  scwbs block "DB migration is required"
```

## `scwbs check-diff`

### 目的

現在差分がTask Contractに違反していないか検査する。

### 基本形

```bash
scwbs check-diff --task WBS-001
```

### 検査項目

```text
- branchName一致
- allowedPaths外変更なし
- forbiddenPaths変更なし
- humanGateRequiredPaths変更時はApprovalあり
- managedContractPathsの許可操作のみ
- Evidence存在
- requiredChecks結果あり
- Approval scope一致
- WBS changeset再現性
```

### Exit code

| Exit code | 意味 |
|---:|---|
| 0 | 問題なし |
| 1 | Errorあり |
| 2 | ツール実行エラー |
| 3 | 設定不備 |

## `scwbs block`

### 目的

AIまたは人間が作業を停止する。

### 基本形

```bash
scwbs block "DBスキーマ変更が必要"
```

### オプション

```bash
scwbs block "検索条件の業務ルールが未確定" \
  --task WBS-001 \
  --kind spec-change \
  --level 2
```

### 生成物

```text
contracts/blocks/<task-id>.yaml
```

必要に応じて:

```text
contracts/approvals/<task-id>.yaml       # status: requested
contracts/spec-changes/<id>.yaml         # draft/proposed
contracts/changesets/<id>.json           # blocked化changeset draft
```

### 注意

`block` は承認ではない。
作業停止と判断依頼を記録するだけである。

## `scwbs request-approval`

### 目的

承認依頼を作る。
AIも実行してよい。

### 基本形

```bash
scwbs request-approval WBS-001 --reason "security path changed"
```

### 生成物

```yaml
status: requested
```

approvedにはしない。

## `scwbs approve`

### 目的

人間が承認する。
AIは実行してはいけない。

### 基本形

```bash
scwbs approve WBS-001 --pr 42 --reason "レビュー済み"
```

### 処理

```text
1. 現在のPR headCommit取得
2. diffHash計算
3. Approval record生成
4. 古いapprovalをstale扱いにする
```

### Approval scope

```yaml
scope:
  pullRequest: "#42"
  headCommit: abc1234
  diffHash: sha256:...
```

## `scwbs next`

### 目的

次に必要な作業を表示する。

### 優先順位

```text
1. blocked task
2. approval required
3. failed check
4. missing Evidence
5. stale lock
6. review required
7. planned task
```

### 出力例

```text
Next: WBS-001 needs Evidence
Fix:
  scwbs finish
```

## `scwbs fix`

### 目的

安全な修復だけ自動実行する。

### 自動実行してよいもの

```text
- registry rebuild
- packet再生成
- Evidence refresh
- generated index更新
```

### 自動実行してはいけないもの

```text
- human approval
- completed化
- spec承認
- DB/API/Auth/Permission変更承認
```

## JSON出力

すべての主要コマンドは `--json` を持つ。

```bash
scwbs check-diff --task WBS-001 --json
```

CIやAIツール連携ではJSONを使う。

## npm script互換

既存のNodeプロジェクトでは以下も使える。

```bash
npm run scwbs -- finish
```

ただし、AI Packetに表示するコマンドは短くする。

```text
scwbs finish
```

