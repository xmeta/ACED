# 02. Command-First Workflow

SC-WBS Core では、YAML/JSONを直接編集しない。人間とAIは短いコマンドで作業する。

この文書のコマンド例は Core の目標形を示す。現行 ACED CLI で作業する場合は、`AGENTS.md` に記載された `npm run scwbs -- ...` 形式の実装済みコマンドを使う。

## 通常の人間ワークフロー

### 1. タスクを作る

```bash
scwbs task new "スタッフ検索APIを実装" \
  --paths src/features/staff-search/**,tests/features/staff-search/** \
  --checks test,typecheck \
  --stop db,auth,permission,breaking-api
```

生成物:

```text
contracts/tasks/WBS-001.yaml
必要なら contracts/tasks/index.yaml
必要なら contracts/changesets/*.json
```

### 2. AIに作業を渡す

```bash
scwbs start WBS-001
scwbs packet --tiny
```

AIに渡すのは `packet --tiny` の出力を基本とする。

### 3. AIが作業する

AIは `allowedPaths` 内だけを変更する。
危険変更が必要になったら実装を止める。

```bash
scwbs block "DBスキーマ変更が必要"
```

### 4. 完了処理をする

```bash
scwbs finish
```

`finish` は次を実行する。

```text
- taskId推定
- requiredChecks実行
- changedFiles収集
- diffHash生成
- Evidence生成/更新
- check-diff実行
- 次に必要なアクション表示
```

### 5. PR後にEvidenceを更新する

```bash
scwbs finish --pr 42
```

### 6. 人間が承認する

```bash
scwbs approve WBS-001 --pr 42 --reason "レビュー済み"
```

Approval は PR番号だけでなく、承認時点の `headCommit` と `diffHash` に紐づける。

## AIが覚えるコマンド

AIが覚えるべき通常コマンドは少なくする。

```bash
scwbs next
scwbs start <task-id>
scwbs packet --tiny
scwbs finish
scwbs block "<reason>"
```

AIに `evidence collect --test-assertions-added ...` のような長いコマンドを覚えさせない。

## 診断から修復へ

`check`、`health`、`finish`、`check-diff` は、失敗時に `fixCommand` を表示する。

例:

```text
ERROR: Evidence missing for WBS-001
Fix:
  scwbs finish

ERROR: Approval required for humanGateRequiredPaths
Fix:
  scwbs request-approval WBS-001 --reason "security path changed"
```

安全な修復だけは `scwbs fix` で自動化してよい。

自動修復してよいもの:

- registry rebuild
- Evidence再生成
- Packet再生成
- Review request draft作成
- stale lockの検出とrefresh提案

自動修復してはいけないもの:

- human approval
- completed化
- spec変更承認
- DB/API/権限変更承認
- release判断
