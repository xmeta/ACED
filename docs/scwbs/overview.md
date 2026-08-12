# SC-WBS概要とBootstrap

出典: docs/sc-wbs-development.mdを分割した参照文書。

# SC-WBS開発

SC-WBS Development は、人間とAIが協調してソフトウェアを開発するための開発手法である。

正式名称は以下とする。

```text
AI-Collaborative Spec Contract and WBS Driven Development
```

本プロジェクトでは、この手法を `scwbs` CLI と `wjs` の WBS-JSON によって運用する。

この文書は方法論と運用ルールを定義する。CLIの具体的な使い方はルートの `README.md` を参照する。

Spec Contract fileは`contracts/specs/*.yaml`配下に置く。Minimum required fieldは`id`、`type: spec-contract`、`featureId`、`title`、`status`、`version`、`acceptanceCriteria`である。`status: approved`の場合は`approvedBy`と`approvedAt`もrequiredになる。`contracts/registry.yaml`はindexとして残るが、各`type: spec` entryはregistry metadataと`id`、`featureId`、`status`、`version`が一致するSpec Contract fileを指さなければならない。
---

## 1. 基本方針

SC-WBS Development の最重要ルールは以下である。

```text
AIは、契約されていない作業をしてはいけない。
```

次に重要なルールは以下である。

```text
Doneは、作業者の申告ではなくEvidenceで判断する。
```

AIは実装、調査、整理、検証、文書化を支援する。人間は目的、制約、承認、責任を管理する。

AIに最終判断を委ねてはいけない領域は以下である。

* 業務ルールの最終決定
* セキュリティ方針
* 個人情報の扱い
* 権限設計
* DBスキーマの重要変更
* API契約の破壊的変更
* 外部サービス連携方針
* 課金・決済関連
* リリース判断
* スコープ変更
* 納期・予算への影響判断

---

## 2. ツール前提の正本ルール

本プロジェクトでは、WBSをMarkdown表では管理しない。

WBSの正本は以下である。

```text
contracts/wbs/project.wbs.json
```

このファイルは `wjs/schema/wbs-json.schema.json` に準拠する。

SC-WBS固有の契約情報は、WBS-JSONとは分けて以下に置く。

```text
contracts/
  registry.yaml
  specs/
    SPEC-001.yaml
  wbs/
    project.wbs.json
  tasks/
    WBS-001-004.yaml
  evidence/
    WBS-001-004.yaml
  approvals/
```

それぞれの役割は以下である。

| ファイル | 役割 |
|---|---|
| `contracts/wbs/project.wbs.json` | WBS階層、状態、依存関係、成果物参照の正本 |
| `contracts/tasks/*.yaml` | AIが作業するためのTask Contract |
| `contracts/evidence/*.yaml` | 完了判定に使うEvidence |
| `contracts/approvals/*` | Human Gateの承認記録 |
| `contracts/registry.yaml` | 契約・成果物の索引 |
| `docs/sc-wbs-development.md` | 方法論と運用ルール |
| `README.md` | ツール利用者向け入口 |

Markdownは説明、レビュー、閲覧に使ってよい。ただし、WBS状態や依存関係についてはWBS-JSONを正とする。

---

## 3. 全体フロー

開発は以下の流れで進める。

```text
Bootstrap Contract
  ↓
Product Vision / Requirement / Spec
  ↓
WBS-JSON node
  ↓
Task Contract
  ↓
AI Work Packet
  ↓
Implementation
  ↓
Verification
  ↓
Evidence
  ↓
Review
  ↓
Human Gate
  ↓
Done
```

主要な契約成果物の役割は以下である。

| 成果物 | 役割 |
|---|---|
| Product Vision | 目的、対象ユーザー、成功条件、作らないものを定義する |
| Requirement Contract | ユーザー要求、背景、業務ルール、受け入れ条件を契約化する |
| Spec Contract | 実装可能な粒度で入力、出力、権限、正常系、異常系、Acceptance Criteriaを定義する |
| WBS-JSON node | 仕様を作業、成果物、マイルストーンへ分解し、状態と依存関係を管理する |
| Task Contract | AIが実行してよい作業範囲、変更可能パス、禁止パス、完了条件を定義する |
| Evidence | Done条件を満たしたことを示す証跡を記録する |

Human Gateは最後の確認だけではない。仕様、DB、権限、APIなどの承認が必要な変更を検出した時点で、実装前に挟む。

`scwbs` はこの流れのうち、以下を機械的に支援する。

* WBS-JSONの検証
* Task Contractの検証
* Evidenceの存在確認
* requiredChecksの確認
* allowedPaths / forbiddenPaths のGit差分検査
* Human Gate対象変更の検出
* AI Work Packet生成
* WBS状態の集計

---

## 4. Bootstrap Contract

ゼロから開始するプロジェクトでは、最初のSpec ContractやTask Contractがまだ存在しない。

そのため、DiscoveryからSpecificationまでの期間に限り、Bootstrap Contractを使う。

Bootstrap ContractでAIに許可する作業は以下に限る。

* Product Visionの草案作成
* 用語集の草案作成
* 要求のヒアリング項目作成
* Requirement Contractの草案作成
* Spec Contractの草案作成
* WBS候補の作成
* リスク、未確定事項、Human Gate候補の抽出

Bootstrap Contractでは、AIは実装してはならない。

通常運用へ移行する条件は以下である。

* Product Visionが人間に承認されている
* Requirement ContractまたはSpec Contractが人間に承認されている
* WBS-JSONに対象nodeがある
* 実装対象タスクのTask Contractがある

---
