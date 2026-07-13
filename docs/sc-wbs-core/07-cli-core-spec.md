# 07. SC-WBS Core CLI Specification

この文書は、SC-WBS Core のCLI仕様を定義する。

ここにある短縮コマンドは Core の target spec である。現行 ACED CLI で実装済みのコマンド一覧は `README.md` と `docs/scwbs/cli-reference.md` を参照する。

## 設計原則

```text
短いコマンドを優先する。
AIにスキーマを覚えさせない。
YAML/JSONはコマンドが生成する。
診断結果には fixCommand を出す。
危険操作はdry-runを既定にする。
Human approval は自動生成しない。
```

## コマンド一覧

### `scwbs next`

次に必要な作業を表示する。

優先順位:

1. blocked task の人間判断
2. stale lock
3. missing Evidence
4. failed check
5. approval required
6. review required
7. planned task

Core では、`next` も「方法論の案内」より「今すぐ取るべき修復行動」の提示を優先する。

出力例:

```text
Next: WBS-001 needs Evidence
Fix:
  scwbs finish
```

### `scwbs task new "<title>"`

Task Contractを生成する。

```bash
scwbs task new "スタッフ検索APIを実装" \
  --paths src/features/staff-search/**,tests/features/staff-search/** \
  --checks test,typecheck \
  --stop db,auth,permission,breaking-api
```

生成物:

```text
contracts/tasks/<task-id>.yaml
必要なら contracts/tasks/index.yaml
必要なら WBS changeset
```

既存ファイルを上書きしない。上書きには明示的な `--force` を必要とする。

### `scwbs start <goal>`

作業開始のpre-flight、または新規Taskの開始を行う。
引数に既存のtask-idを指定した場合はpre-flightを、新規のgoal文字列を指定した場合はspec/task/changesetドラフトを生成する。

処理（既存task-idの場合）:

```text
- branch確認または作成
- Task Contractのlock確認
- allowedPaths / forbiddenPaths表示
- Stop Conditions表示
- Tiny Packet生成案内
```

処理（新規goalの場合）:

```text
- spec/task/changesetドラフト生成
- branch名の提示
- 次アクションの表示
```

### `scwbs packet`

現在taskのPacketを出力する。既定は `--tiny`。

3段階のレベル:

```bash
scwbs packet --task WBS-001              # 既定: --tiny
scwbs packet --task WBS-001 --tiny       # 最小: Task ID, Objective, Paths, Checks, Next
scwbs packet --task WBS-001 --standard   # 標準: Tiny + WBS Node詳細, Stop Conditions
scwbs packet --task WBS-001 --full       # 詳細: Standard + relation depth 1
```

互換性のためのエイリアス: `--standard` = `--normal`、`--full` = `--deep`。

### `scwbs finish`

作業完了処理を行う。

処理:

```text
- 現在branchからtaskId推定
- requiredChecks実行
- changedFiles収集
- diffHash生成
- Evidence生成/更新
- check-diff実行
- 次アクション表示
```

PR作成後:

```bash
scwbs finish --pr 42
```

### `scwbs check-diff`

現在差分がTask Contractに違反していないか検査する。

検査:

```text
- allowedPaths外変更
- forbiddenPaths変更
- humanGateRequiredPaths変更とApproval有無
- メタファイル変更
- managedContractPathsの許可操作
- branch不一致
- Evidence存在
- Approval scope一致
- WBS changeset再現性
```

このコマンドは Core の最重要機能である。AIが全ルールを暗記していなくても、機械的に止められる違反はここで止める。

### `scwbs block "<reason>"`

AIまたは人間が作業停止を記録する。

```bash
scwbs block "DBスキーマ変更が必要"
```

生成物:

```text
contracts/blocks/<task-id>.yaml
必要なら approval requested record
必要なら spec-change proposal draft
必要なら WBS blocked changeset
```

### `scwbs request-approval <task-id>`

人間判断が必要な承認依頼を作る。

```bash
scwbs request-approval WBS-001 --reason "security path changed"
```

AIはこのコマンドを使ってよい。

### `scwbs approve <task-id>`

人間が承認する。

```bash
scwbs approve WBS-001 --pr 42 --reason "レビュー済み"
```

処理:

```text
- PR headCommit取得
- diffHash計算
- Approval record生成
- 古いApprovalをsupersededまたはstale扱い
```

AIはこのコマンドを実行してはいけない。

### `scwbs fix`

安全な自動修復だけを実行する。

実行してよいもの:

```text
- registry rebuild
- Evidence refresh
- Packet再生成
- Review request draft
```

実行してはいけないもの:

```text
- human approval
- completed化
- spec承認
- DB/API/権限変更承認
```

## エラー出力形式

すべてのエラーは、AIが次の行動を決めやすい形式にする。

```text
ERROR SCWBS_PATH_FORBIDDEN
Task: WBS-001
File: migrations/001_add_table.sql
Reason: forbiddenPaths matched migrations/**
Fix:
  scwbs block "DB migration is required"
```

## 現行ACED CLIとの関係

Core の目標形では短縮コマンドを優先する。ただし、現行 ACED CLI で作業する場合は npm script 経由の実装済みコマンドを使う。

Core target:

```bash
scwbs finish
```

現行ACED:

```bash
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
```
