# 09. AI Agent Guidelines

この文書は、AIエージェントに読ませるための短い運用指示である。

## 適用範囲

この文書は次期Core改訂案のAI向け指示であり、現行 ACED CLI の実装済みコマンド一覧ではない。
現行 ACED で実作業を行うAIは、まず `AGENTS.md` と対象 Task Contract を優先する。

この文書内の `scwbs finish`、`scwbs packet --tiny`、`scwbs block` などの短縮形は目標形である。
現行 CLI で同名実装がない場合は、`AGENTS.md` にある `npm run scwbs -- ...` 形式の実装済みコマンドへ読み替える。

## 最初に読むこと

AIは、SC-WBSの全仕様を読む必要はない。

通常は、以下だけでよい。

```text
1. AGENTS.md
2. 対象 Task Contract
3. このファイル、または Tiny Packet
4. 対象ファイル
```

## 基本ルール

Core 目標形では、AIは次の短縮コマンドを使う。

```text
契約されていない作業をしない。
allowedPaths外を変更しない。
forbiddenPathsを変更しない。
Human Gate対象変更が必要なら停止する。
完了時は scwbs finish を実行する。
困ったら scwbs block "理由" を実行する。
```

現行 ACED では、未実装の短縮形を次の実装済みコマンドへ読み替える。

```bash
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- ai block --task <task-id> --reason "<reason>"
```

## 作業開始

Core 目標形では、人間またはツールからTask IDを受け取ったら、以下を使う。

```bash
scwbs start WBS-001
scwbs packet --task WBS-001 --tiny
```

現行 ACED では、対象 Task Contract を先に読み、必要な場合だけ次を補助的に使う。

```bash
npm run scwbs -- ai packet --task WBS-001 --relation-depth 1
```

Tiny Packetに書かれている範囲だけを作業する。

## 実装中の判断

### 続けてよい場合

```text
- allowedPaths内の変更だけで完了できる
- 既存Specから一意に判断できる
- DB/API/Auth/Permission/Securityを変更しない
- 既存テストを弱体化しない
```

### 止まる場合

以下に該当したら、実装を続けない。

```text
- DBスキーマ変更が必要
- migration追加が必要
- 認証方式変更が必要
- 権限設計変更が必要
- API破壊的変更が必要
- セキュリティ設定変更が必要
- 個人情報の扱い変更が必要
- 業務ルールが未確定
- allowedPaths外の変更が必要
- forbiddenPaths変更が必要
```

Core 目標形では、止まるときは短く記録する。

```bash
scwbs block "DBスキーマ変更が必要"
```

現行 ACED では次を使う。

```bash
npm run scwbs -- ai block --task WBS-001 --reason "DBスキーマ変更が必要"
```

## 完了時

Core 目標形では、作業が終わったら以下を実行する。

```bash
scwbs finish
```

現行 ACED では次を順に実行する。

```bash
npm run scwbs -- evidence collect --task WBS-001
npm run scwbs -- check-diff --task WBS-001
```

`finish` が失敗したら、出力された `Fix:` に従う。

例:

```text
Fix:
  scwbs block "DB migration is required"
```

## AIが実行してよいコマンド

| 用途 | Core目標形 | 現行ACED |
|---|---|---|
| Packet生成 | `scwbs packet --task WBS-001 --tiny` | `npm run scwbs -- ai packet --task WBS-001 --relation-depth 1` |
| Evidence生成 | `scwbs finish` | `npm run scwbs -- evidence collect --task WBS-001` |
| 差分検査 | `scwbs check-diff --task WBS-001` | `npm run scwbs -- check-diff --task WBS-001` |
| 作業停止 | `scwbs block "理由"` | `npm run scwbs -- ai block --task WBS-001 --reason "理由"` |
| 次作業確認 | `scwbs next` | `npm run scwbs -- next` |

## AIが実行してはいけないコマンド

```bash
scwbs approve WBS-001
scwbs complete WBS-001
scwbs release
```

承認は人間が行う。
AIは承認依頼までしかしてはいけない。

## YAML/JSONについて

AIは原則として以下を手で作らない。

```text
contracts/tasks/*.yaml
contracts/evidence/*.yaml
contracts/approvals/*.yaml
contracts/blocks/*.yaml
contracts/changesets/*.json
```

必要な場合はCLIを使う。現行 ACED では `AGENTS.md` の npm script 経由コマンドを優先する。

| やりたいこと | Core目標形 | 現行ACED |
|---|---|---|
| Evidence生成 | `scwbs finish` | `npm run scwbs -- evidence collect --task WBS-001` |
| 作業停止 | `scwbs block "理由"` | `npm run scwbs -- ai block --task WBS-001 --reason "理由"` |
| 差分検査 | `scwbs check-diff --task WBS-001` | `npm run scwbs -- check-diff --task WBS-001` |

## 変更してはいけない例

```text
- package.json
- lock files
- migrations/**
- src/auth/**
- src/security/**
- .github/**
```

ただし、Tiny Packetで明示的に許可されている場合は、その範囲に限ってよい。
Human Gate対象の場合は承認なしで進めない。

## レビュー前の自己確認

完了前に確認する。

```text
- Tiny Packetのgoalを満たしたか
- allowedPaths外を変更していないか
- forbiddenPathsを変更していないか
- Stop Conditionを無視していないか
- テストを弱体化していないか
- Core目標形では scwbs finish が通ったか
- 現行ACEDでは evidence collect と check-diff が通ったか
```

## 出力されたFixを優先する

`scwbs` が `Fix:` を表示した場合、AIはそれを優先する。

ただし、`approve` や `complete` のような人間専用コマンドは実行しない。
その場合は、人間に判断を求める。
