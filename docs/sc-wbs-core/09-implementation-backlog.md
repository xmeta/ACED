# 09. Implementation Backlog

この文書は、SC-WBS Core を実装するための優先タスク候補である。

## P0: 最初に実装するもの

P0の判断基準:

```text
- AIに渡す文脈を小さくできる
- 差分違反を機械的に止められる
- 手書きYAMLを減らせる
```

### CORE-001: `scwbs task new`

目的:

```text
YAMLを手書きせずTask Contractを作れるようにする。
```

必須:

- titleからtaskId候補を生成
- allowedPathsをCLI引数または対話式で入力
- checksを選択
- stopIfプリセットを選択
- 既存ファイルは上書きしない

### CORE-002: `scwbs packet --tiny`

目的:

```text
AIに渡す最小作業カードを生成する。
```

必須:

- goal
- allowedPaths
- forbiddenPaths
- humanGateRequiredPaths
- stopIf
- checks
- whenDone
- whenBlocked

### CORE-003: `scwbs finish`

目的:

```text
Evidence生成、checks実行、check-diffを1コマンドにまとめる。
```

必須:

- 現在branchからtaskId推定
- checks実行
- changedFiles収集
- diffHash生成
- Evidence生成
- check-diff実行
- fixCommand表示

### CORE-003a: metadata-only finish workflow

目的:

```text
Task Contract / Evidence / Review / Registry だけを更新する小規模作業で、
Evidence収集や検証を何度も繰り返さずに完了できるようにする。
```

必須:

- `finish` が PR 番号を受け取り、Evidence の `git.pullRequest` を最終更新できる
- Review request と registry rebuild を finish 後処理としてまとめられる
- metadata-only 作業では required checks の重複実行を避ける実行計画を表示できる
- 最終状態では Evidence、Review、Registry、check-diff が通常タスクと同じ保証を持つ
- Evidence 自身や Review record の追加で `subjectHeadCommit` / `diffHash` が不要に揺れない

### CORE-004: Evidenceの `subjectHeadCommit` / `diffHash`

目的:

```text
Evidenceファイル自体のコミットでstaleになる問題を避ける。
```

### CORE-005: Approval scope検証

目的:

```text
承認後の追加コミットを検出する。
```

必須:

- approval.headCommit
- approval.diffHash
- 現在PR差分との一致検証

### CORE-006: `scwbs block "<reason>"`

目的:

```text
AIが危険変更を短いコマンドで停止できるようにする。
```

## P1: 次に実装するもの

P1は、Coreの薄い運用を壊さずに安全性と修復性を上げる項目である。

### CORE-101: `fixCommand` 標準化

全エラーに修復候補を出す。

### CORE-102: `managedContractPaths`

EvidenceやBlock生成がallowedPaths違反にならないようにする。

### CORE-103: Human Gate判定強化

Standard以上では、承認なしの `humanGateRequiredPaths` 差分をErrorにする。

### CORE-104: `scwbs approve`

人間承認を短いコマンドで作成する。

### CORE-105: `scwbs request-approval`

AIがapprovedではなくrequested recordを作れるようにする。

## P2: 大きくなってから実装するもの

P2は Full への拡張であり、Core の採用前提条件ではない。

### CORE-201: WBS-JSON optional化

小規模では `contracts/tasks/index.yaml` で依存管理し、必要になったらWBS-JSONへ昇格する。

### CORE-202: WBS changeset再現性検証

base WBS + changesets = HEAD WBS を検証する。

### CORE-203: Review Contract schema

Review結果を機械判定できるようにする。

### CORE-204: Spec Change Proposal生成

`scwbs block --kind spec-change` からSCPを生成する。

## 実装しない/後回しにするもの

- Strict ProfileのRisk Register完全実装
- 監査ログ完全実装
- Web UI
- 複雑なReviewer routing
- AI agent自動実行

Coreの価値は、まず「短いPacket」「範囲外変更検出」「Evidence生成」で出す。
