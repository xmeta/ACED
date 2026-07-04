# 02. Implementation Plan

この文書は、SC-WBS Core 改訂を実装するための計画である。

## 実装方針

最初からFull機能を作らない。

```text
Phase 1: Core CLIの最小価値を作る
Phase 2: Evidence / Approval / check-diff の安全性を固める
Phase 3: WBS optional運用と移行を整える
Phase 4: Review / Spec Change / Full連携を追加する
```

最重要は、以下の1サイクルを短いコマンドだけで回せるようにすることである。

```bash
scwbs task new "作業名"
scwbs start WBS-001
scwbs packet --tiny
# AIまたは人間が実装
scwbs finish
scwbs next
```

危険変更が必要な場合は、以下で止める。

```bash
scwbs block "DBスキーマ変更が必要"
```

## マイルストーン

## M0: 現状整理と互換レイヤー

目的:

```text
既存コマンドと新Coreコマンドの対応関係を決める。
破壊的変更を避ける。
```

成果物:

- 既存CLIコマンド一覧
- 新Coreコマンド一覧
- deprecatedにするコマンド候補
- alias設計

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M0-001 | 既存CLI棚卸し | コマンド、入力、出力、生成ファイルが一覧化されている |
| M0-002 | Core alias設計 | `finish` など短縮コマンドの対応先が決まっている |
| M0-003 | 後方互換方針 | 既存 `npm run scwbs -- ...` が壊れない |

## M1: Core Task Lifecycle

目的:

```text
YAML直書きなしでTask作成からPacket生成までできるようにする。
```

対象コマンド:

```bash
scwbs task new
scwbs start
scwbs packet --tiny
scwbs next
```

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M1-001 | `task new` 実装 | title, paths, checks, stop presets からTask Contractを生成できる |
| M1-002 | 対話式入力 | 引数不足時に安全な対話式で補える |
| M1-003 | taskId採番 | 既存taskと衝突しないIDを生成できる |
| M1-004 | branch名生成 | titleから安全なbranch名を生成できる |
| M1-005 | `start` 実装 | branch確認、lock確認、pre-flight表示ができる |
| M1-006 | `packet --tiny` 実装 | AIに渡す最小作業カードを出力できる |
| M1-007 | `next` Core優先順位 | blocked、missing evidence、failed check、planned taskを順に表示できる |

受け入れ条件:

```text
新規タスクをYAML手書きなしで作れる。
AIに渡すTiny Packetが50行以内になる。
既存Task Contractがある場合はそれを読み込める。
```

## M2: Finish / Evidence / Diff Guard

目的:

```text
作業完了時に、Evidence生成と差分検査を1コマンドで行う。
```

対象コマンド:

```bash
scwbs finish
scwbs check-diff
```

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M2-001 | taskId推定 | branch名または引数からtaskIdを推定できる |
| M2-002 | requiredChecks実行 | Check Catalogに基づいてtest/typecheck等を実行できる |
| M2-003 | changedFiles収集 | base...HEAD の差分ファイルを収集できる |
| M2-004 | diffHash生成 | 差分内容から安定したhashを生成できる |
| M2-005 | Evidence生成 | `subjectHeadCommit`, `baseCommit`, `diffHash`, `checks` を記録できる |
| M2-006 | allowedPaths検査 | 範囲外変更をErrorにできる |
| M2-007 | forbiddenPaths検査 | 禁止パス変更をErrorにできる |
| M2-008 | managedContractPaths検査 | Evidence等の生成ファイルだけ例外扱いできる |
| M2-009 | fixCommand出力 | すべてのErrorに次の行動を表示できる |

受け入れ条件:

```text
scwbs finish だけで checks -> Evidence -> check-diff まで完了する。
EvidenceファイルをコミットしてもsubjectHeadCommitがstale扱いにならない。
allowedPaths外変更を検出できる。
```

## M3: Human Gate / Block / Approval Scope

目的:

```text
危険変更をAIが短いコマンドで停止でき、人間承認はcommit/diffに紐づくようにする。
```

対象コマンド:

```bash
scwbs block
scwbs request-approval
scwbs approve
```

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M3-001 | `block` 実装 | 理由からBlock recordを生成できる |
| M3-002 | Stop preset判定 | db/auth/api/security等の停止理由を分類できる |
| M3-003 | request approval | AIがrequested recordだけ生成できる |
| M3-004 | approve | 人間がapproved recordを生成できる |
| M3-005 | Approval scope | `headCommit` と `diffHash` をApprovalに記録できる |
| M3-006 | scope検証 | 承認後の追加コミットをErrorにできる |
| M3-007 | completed保護 | 承認なしでcompletedにできない |

受け入れ条件:

```text
AIはapproval approve相当の操作を実行できない設計になっている。
ApprovalはPR番号だけでなくdiffHashに紐づく。
承認後に差分が変わると再承認が必要になる。
```

## M4: WBS Optional / Full Integration

目的:

```text
小規模ではWBSなし、大きくなったらWBSへ昇格できるようにする。
```

対象:

```text
contracts/tasks/index.yaml
contracts/wbs/project.wbs.json
contracts/changesets/*.json
```

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M4-001 | tasks index | WBSなしでtask依存を管理できる |
| M4-002 | WBS検出 | WBSがある場合は既存仕様に従う |
| M4-003 | WBS昇格 | tasks indexからWBS候補を生成できる |
| M4-004 | changeset生成 | WBS変更をコマンドで生成できる |
| M4-005 | changeset再現性検証 | base WBS + changesets = HEAD WBS を検証できる |

受け入れ条件:

```text
WBSなしでもCoreの作業サイクルが動く。
WBSありの既存プロジェクトでも互換性が保たれる。
```

## M5: Review / Spec Change / Full Enhancement

目的:

```text
Coreの上にFull機能を安全に戻す。
```

主な作業:

| ID | 作業 | 完了条件 |
|---|---|---|
| M5-001 | Review record | Review結果を生成・検証できる |
| M5-002 | review request | review依頼をCLIで作れる |
| M5-003 | Spec Change Proposal生成 | blockからSCP draftを作れる |
| M5-004 | registry連携 | Full modeではregistry検証を行う |
| M5-005 | profile enforcement | Lean/Core/Standard/Strictの違いを機械判定できる |

## 実装優先順位

最短で価値を出す順番は以下である。

```text
1. packet --tiny
2. check-diff
3. finish
4. task new
5. block
6. approval scope
7. next
8. WBS optional
```

ただし、実際の実装では `task new` と `packet --tiny` を先に作ると、AI自身に開発を手伝わせやすい。

## リリース単位

### v0.1 Core Packet

- `task new`
- `packet --tiny`
- `start`

### v0.2 Diff Guard

- `check-diff`
- `managedContractPaths`
- `fixCommand`

### v0.3 Finish Evidence

- `finish`
- `evidence collect`統合
- `subjectHeadCommit`
- `diffHash`

### v0.4 Human Gate

- `block`
- `request-approval`
- `approve`
- Approval scope検証

### v0.5 WBS Optional

- tasks index
- WBS昇格
- changeset再現性検証

## Done条件

この改訂のMVP完了条件は以下である。

```text
- YAML直書きなしでTaskを作れる。
- Tiny Packetを生成できる。
- finishでEvidenceを生成できる。
- check-diffで範囲外変更を止められる。
- blockで危険変更を停止できる。
- approveで承認をdiffHashに紐づけられる。
- AI向け文書が短い。
```

