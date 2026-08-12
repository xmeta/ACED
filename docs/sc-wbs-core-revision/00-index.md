# 00. SC-WBS Core Revision Index

Status: proposal.

この文書群は、SC-WBS を軽量で効果の大きいツールへ改訂するための設計書である。

このディレクトリは現行の実行ルールではない。実作業では root `AGENTS.md`、
対象 Task Contract、`docs/README.md`、`docs/sc-wbs-core/00-index.md` を先に読む。

進捗確認の短い入口は、リポジトリルートの `CHECKLIST.md` とする。
実装状況を更新する場合は、詳細版の `10-progress-checklist.md` を確認してからチェックを付ける。

## 現行Core文書との関係

このディレクトリは、`docs/sc-wbs-core/` へ将来統合する候補を含む次期改訂案である。
現行 ACED で実作業を行う場合、この文書群の短縮コマンド例をそのまま実装済みコマンドとして扱わない。

優先順位は次の通りである。

```text
1. AGENTS.md と対象 Task Contract: 現行作業の実行ルール
2. docs/sc-wbs-core/: 現行Coreの基準説明
3. docs/sc-wbs-core-revision/: 次期Core改訂案
```

この改訂案を現行Coreへ反映するには、`10-progress-checklist.md` の対象項目をTask Contract化し、実装、テスト、Evidence、check-diffを通す。

## 改訂の目的

既存の SC-WBS は、AI協調開発を安全にするための概念を多く持っている。
一方で、Task Contract、Evidence、Approval、WBS、Registry、Review、Spec Change Proposal などをすべてAIや人間が意識すると、文脈コストと運用コストが増える。

この改訂では、次の形へ寄せる。

```text
人間・AIのUI: 短いCLIコマンド
内部正本: YAML / JSON
AIに渡す情報: Tiny Packet
安全性の担保: check-diff / finish / block / approval scope
```

## 文書一覧

| ファイル | 目的 |
|---|---|
| `01-revision-goals.md` | 改訂のゴール、非ゴール、設計判断 |
| `02-implementation-plan.md` | 実装順序、マイルストーン、タスク分解 |
| `03-detailed-design.md` と `03a`〜`03d` | 全体アーキテクチャと責務別の主要モジュール設計 |
| `04-cli-design.md` | CLIコマンド仕様とUX設計 |
| `05-data-model.md` | 生成されるYAML/JSONの最小データモデル |
| `06-validation-design.md` | check-diff、finish、approval scope の検証設計 |
| `07-testing-plan.md` | テスト方針、受け入れ条件、回帰テスト |
| `08-migration-plan.md` | 既存SC-WBSからCoreへ反映する手順 |
| `09-ai-agent-guidelines.md` | AIエージェントに読ませる短い運用指示 |
| `10-progress-checklist.md` | 実装計画の進捗確認チェックリスト |
| `11-cli-compatibility-map.md` | 既存CLIとCore短縮コマンドの対応表 |

## 読み分け

### 実装者

```text
01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07
```

### AIエージェント

```text
AGENTS.md -> 09-ai-agent-guidelines.md -> 実装対象に関係する詳細設計のみ
```

### PM / レビュー担当

```text
01 -> 02 -> 08 -> 10
```

## 最重要判断

この改訂では、SC-WBS を最初からFull機能として作らない。

まず Core を作る。

```text
Coreで必須:
- task new
- start
- packet --tiny
- finish
- check-diff
- block
- request-approval
- approve
- next

Coreでは任意:
- WBS-JSON
- registry.yaml
- Review Contract
- Strict Profile
- Risk Register
- Web UI
```
