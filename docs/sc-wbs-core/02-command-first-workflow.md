# 02. Command-First Workflow

SC-WBS Core では、YAML/JSONを直接編集しない。人間とAIは短いコマンドで作業する。

この文書のコマンド例は Core の目標形を示す。現行 ACED CLI で作業する場合は、`AGENTS.md` に記載された `npm run scwbs -- ...` 形式の実装済みコマンドを使う。

設計の主眼は「AIに多くを覚えさせること」ではなく、「短いカードで始めさせ、逸脱はツールで止めること」である。

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
scwbs task start WBS-001
scwbs packet --tiny
```

AIに渡すのは `packet --tiny` の出力を基本とする。現行 ACED では `packet --tiny` が実装済みである。Task Contract を先に読み、必要時だけ `ai packet` を補う。

### 3. AIが作業する

AIは `allowedPaths` 内だけを変更する。
危険変更が必要になったら実装を止める。

```bash
scwbs block "DBスキーマ変更が必要"
```

### Discovery Probe で不確実性を先に閉じる

実装前に技術的不確実性を検証する場合は、`contracts/discovery/PROBE-*.yaml`
を正本とする bounded Discovery Probe を作る。Probe は delivery Task と分離し、
question、hypotheses、activities、evidenceExpected、unknowns、timebox、costLimit、
exitConditions、nextDecision を最初に固定する。

```bash
scwbs discovery new \
  --probe PROBE-cache-strategy \
  --question "既存キャッシュで応答時間目標を満たせるか" \
  --hypotheses "既存方式で十分" \
  --activities "代表負荷を測定" \
  --evidence-expected "p95 latency" \
  --unknowns "ピーク時の劣化" \
  --timebox "4h" \
  --cost-limit "one engineer-day" \
  --exit-conditions "代表負荷の測定完了" \
  --next-decision "実装方式を選ぶ" \
  --delivery-task WBS-001
scwbs discovery start --probe PROBE-cache-strategy
```

状態遷移は `proposed -> active -> concluded|inconclusive` のみで、既存Probeを
暗黙に上書きしない。`concluded` は全exit conditionの達成と、学習した事実・
棄却した仮説の記録を要求する。

```bash
scwbs discovery conclude \
  --probe PROBE-cache-strategy \
  --outcome concluded \
  --facts "p95が目標内" \
  --rejected "追加ストアが必須" \
  --exit-conditions-met true
```

時間または費用上限に達して判断できない場合、失敗扱いにせず
`inconclusive` で終了し、残存不確実性と次の判断を明示する。

```bash
scwbs discovery conclude \
  --probe PROBE-cache-strategy \
  --outcome inconclusive \
  --remaining "ピーク負荷の再現性" \
  --next-decision "追加Probeの費用を判断"
```

delivery Task に関連付けられたProbeは `concluded` になるまで `scwbs check`
を失敗させ、Tiny Packetにも停止指示を表示する。`inconclusive` は正常な終端
だが、delivery開始を許可する根拠にはならない。

### Rolling Wave Planning

`scwbs plan` は固定的な実装・テスト・文書化Taskを一括生成しない。approved
Specの `planning` 入力から、遠い作業を粗い `approachCandidates` として残し、
直近の1〜3件だけを `readyWindow` としてTask Contract化する。

```yaml
planning:
  unresolvedDecisions: []
  dependencies:
    - API contract is approved
  gates:
    - no database migration
  uncertainty: low
  probeIds:
    - PROBE-cache-strategy
  readyWindow:
    - id: cache-adapter
      title: Implement the bounded cache adapter
      paths:
        - src/cache/**
        - tests/cache/**
      requiredChecks:
        - test
        - typecheck
  approachCandidates:
    - Evaluate distributed invalidation after usage data exists
```

```bash
scwbs plan --spec SPEC-CACHE --json
```

未承認Specは拒否する。`unresolvedDecisions` が残る、または `uncertainty: high`
であり、関連する全Probeが `concluded` でなければdelivery Taskを生成せず、
Discovery Probeを作る。Ready Windowのpathには `src/**` などの広域scopeを
指定できない。

計画正本は `contracts/plans/PLAN-*.json` であり、同じSpecの暗黙上書きを
禁止する。再計画では理由を必須とし、前計画hashとTaskのadded/removed/retained
差分を記録する。removedは履歴保護のため既存Taskを自動削除しない。

```bash
scwbs plan --spec SPEC-CACHE \
  --replan-reason "Probe結果により実装順序を変更" \
  --json
```

### 4. 完了処理をする

手動確認でrequired checksを先に実行する場合は、正規入口からprovenance付きreceiptを作る。

```bash
scwbs checks run --task WBS-001
```

receiptは現在のtask、HEAD、差分、resolved command、dependency lockfile、submodule状態に拘束される。続く `finish` は完全一致する成功結果だけを再利用するため、同じ高コストcheckを重複実行しない。明示的に再実行する場合は `--rerun-checks` を使う。

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

AIが覚えるべき通常コマンドは少なくする。ここで重要なのは、ルールを長文で覚えさせることではなく、完了時に `check-diff` が逸脱を止めることである。

```bash
scwbs next
scwbs task start <task-id>
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

stale lockのrefreshは `task refresh --task <id>` のpreviewで理由と安全な
更新範囲を確認してから行う。refreshは `contractLock` メタデータだけを
更新し、Taskのauthorityを変更しない。WBS/Specの意味変更を受け入れる
ためにscopeやchecksなどを変更する必要がある場合は、refreshを承認代わり
に使わず、Human Approvalまたは新しいTask/Specのライフサイクルへ戻る。

自動修復してはいけないもの:

- human approval
- completed化
- spec変更承認
- DB/API/権限変更承認
- release判断
