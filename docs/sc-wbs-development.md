# AI協調型 仕様契約・WBS駆動開発

## 1. 概要

AI協調型 仕様契約・WBS駆動開発は、人間とAIが協調してソフトウェアを開発するための開発手法である。

英語表記は以下とする。

```text
AI-Collaborative Spec Contract and WBS Driven Development
```

略称は以下とする。

```text
SC-WBS Development
```

この手法では、AIに曖昧な依頼を渡して場当たり的に実装させるのではなく、仕様・作業範囲・制約・承認条件・完了証跡を明確にしたうえで開発を進める。

管理する対象は以下である。

* 何を作るのか
* なぜ作るのか
* 誰のために作るのか
* どこまで作るのか
* 何を作らないのか
* どの作業を誰が担当するのか
* AIが変更してよい範囲はどこか
* AIが変更してはいけない範囲はどこか
* 人間の承認が必要な変更は何か
* 完了したと判断する根拠は何か
* 進捗・リスク・ブロッカーはどこで管理するのか

最重要ルールは以下である。

```text
AIは、契約されていない作業をしてはいけない。
```

次に重要なルールは以下である。

```text
Doneは、作業者の申告ではなくEvidenceで判断する。
```

---

## 2. 基本思想

AIは単なるコード生成ツールではない。要求整理、仕様化、設計案作成、作業分解、実装、テスト作成、レビュー、ドキュメント更新、リスク抽出、進捗整理を支援できる。

一方で、AIに最終判断を委ねてはいけない領域がある。

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

本手法では、人間とAIの役割を以下のように分ける。

```text
人間は目的・制約・承認・責任を管理する。
AIは調査・整理・実装・検証・文書化を支援する。
```

---

## 3. 全体構造

本手法は、以下の流れで開発を進める。

```text
Bootstrap Contract
  ↓
Product Vision
  ↓
Requirement Contract
  ↓
Spec Contract
  ↓
WBS Decomposition
  ↓
Task Contract
  ↓
Implementation
  ↓
Verification
  ↓
Review
  ↓
Human Gate
  ↓
Release
  ↓
Knowledge Update
```

| 項目 | 内容 |
|---|---|
| Bootstrap Contract | 契約を作るための最初の作業範囲を定義する |
| Product Vision | プロダクトの目的・価値・対象ユーザーを定義する |
| Requirement Contract | 要求を契約として明文化する |
| Spec Contract | 機能仕様を実装可能な粒度で契約化する |
| WBS Decomposition | 仕様を作業単位へ分解する |
| Task Contract | 各作業の目的・範囲・制約・完了条件を定義する |
| Implementation | AIまたは人間が実装する |
| Verification | テスト、型チェック、Lint、セキュリティ確認を行う |
| Review | AIレビューと人間レビューを行う |
| Human Gate | 人間の承認が必要な判断を行う |
| Release | リリース可否を判断し、実施する |
| Knowledge Update | 仕様、WBS、ADR、AGENTS.mdなどを更新する |

---

## 4. Bootstrap Contract

「AIは、契約されていない作業をしてはいけない」という原則は、実装フェーズだけでなく仕様作成にも適用する。

ただし、ゼロから開始するプロジェクトでは、最初のSpec ContractやTask Contractがまだ存在しない。そのため、DiscoveryからSpecificationまでの期間に限り、Bootstrap Contractを使ってAIの作業範囲を管理する。

Bootstrap Contractは、契約を作るための契約である。

### 4.1 適用範囲

Bootstrap Contractを使ってよい作業は以下に限る。

* Product Visionの草案作成
* 用語集の草案作成
* 要求のヒアリング項目作成
* Requirement Contractの草案作成
* Spec Contractの草案作成
* WBS候補の作成
* リスク、未確定事項、Human Gate候補の抽出

Bootstrap Contractでは、AIは実装してはならない。

### 4.2 Bootstrap Contractの形式

```md
# Bootstrap Contract

## Goal
対象プロジェクトまたは対象Featureの初期契約群を作成する。

## Scope
- Product Vision草案
- Glossary草案
- Requirement Contract草案
- Spec Contract草案
- WBS候補
- 未確定事項一覧

## Out of Scope
- 実装
- DBスキーマ変更
- API変更
- リリース判断
- 確定していない業務ルールの断定

## Required Human Decisions
- Product Vision承認
- Requirement Contract承認
- Spec Contract承認
- Human Gate対象の確定

## Done Criteria
- 草案成果物が作成されている
- 未確定事項が明示されている
- 人間承認が必要な項目が列挙されている
- 次に作るTask Contract候補が提示されている
```

### 4.3 Bootstrapから通常運用への移行

Bootstrap Contractで作成された草案は、そのまま確定仕様として扱ってはならない。

通常運用へ移行する条件は以下である。

* Product Visionが人間に承認されている
* Requirement ContractまたはSpec Contractが人間に承認されている
* WBSが作成されている
* 実装対象タスクのTask Contractが作成されている

この条件を満たした後、AIはTask Contract単位で実装作業を行う。

---

## 5. 開発フェーズと状態

### 5.1 フェーズ

| フェーズ | 内容 |
|---|---|
| Discovery | 調査・課題発見 |
| Definition | 要求定義 |
| Specification | 仕様契約作成 |
| Design | 設計 |
| Planning | WBS作成・Task Contract作成 |
| Build | 実装 |
| Verify | 検証 |
| Review | レビュー |
| Release | リリース |
| Operate | 運用 |
| Improve | 改善 |

### 5.2 WBS状態

| 状態 | 意味 |
|---|---|
| Not Started | 未着手 |
| Drafting | 仕様・タスク作成中 |
| Spec Review | 仕様レビュー中 |
| Approved | 仕様承認済み |
| Planning | 実装計画中 |
| Implementing | 実装中 |
| AI Review | AIレビュー中 |
| Human Review | 人間レビュー中 |
| Testing | テスト中 |
| Blocked | ブロック中 |
| Done | 完了 |
| Archived | 終了・保管 |

すべての作業はWBS上で現在状態を持つ。

### 5.3 状態遷移権限

WBS状態は、作業者が自由に更新してはならない。

状態遷移ごとの権限は以下を原則とする。

| 遷移 | 更新権限 |
|---|---|
| Not Started → Drafting | HumanまたはPM Agent |
| Drafting → Spec Review | Spec AgentまたはPM Agent |
| Spec Review → Approved | Humanのみ |
| Approved → Planning | HumanまたはPM Agent |
| Planning → Implementing | HumanまたはImplementation Agent |
| Implementing → AI Review | Implementation Agent |
| AI Review → Human Review | Review AgentまたはPM Agent |
| Human Review → Testing | HumanまたはTest Agent |
| Testing → Done | Humanのみ |
| Any → Blocked | AIまたはHuman |
| Blocked → Planning | HumanまたはPM Agent |
| Done → Archived | HumanまたはPM Agent |

AIは、Evidenceと必要なレビューが揃っていないタスクをDoneにしてはならない。

---

## 6. 運用プロファイル

プロジェクト規模やリスクに応じて、運用プロファイルを選択する。

### 6.1 Lean Profile

個人開発、小規模開発、プロトタイプ向け。

必須成果物:

* AGENTS.md
* Product Vision
* Glossary
* Feature Spec
* Task Contract
* Done Criteria

省略可能:

* 詳細WBS
* 詳細ADR
* Status Report
* 厳格なEvidence
* Contract CI

ただし、以下は省略してはならない。

* AIの作業範囲
* 変更禁止範囲
* 完了条件
* テスト結果
* 仕様変更が必要な場合の停止ルール

### 6.2 Standard Profile

通常の業務アプリケーション開発向け。標準運用はこのProfileとする。

必須成果物:

* AGENTS.md
* Product Vision
* Glossary
* Business Rules
* Requirement Contract
* Spec Contract
* WBS
* Task Contract
* Evidence
* ADR
* Status Report
* Security Checklist

### 6.3 Strict Profile

個人情報、医療、介護、金融、行政、基幹業務など、品質・監査・セキュリティが重要な開発向け。

Standard Profileに加えて、以下を必須とする。

* Human Gate記録
* Security Verification
* Contract CI
* Traceability Matrix
* Change Approval Log
* Risk Register
* Release Checklist
* Documentation Health Check
* 監査ログ方針

---

## 7. 主要成果物

### 7.1 AGENTS.md

AGENTS.mdは、AIが開発時に最初に読むべきルールである。

記載する内容:

* プロジェクト概要
* 必読ドキュメント
* ディレクトリ構成
* 開発コマンド
* テストコマンド
* Lintコマンド
* 型チェックコマンド
* AIが変更してよい範囲
* AIが変更してはいけない範囲
* 人間承認が必要な変更
* コーディング規約
* ドキュメント更新ルール
* セキュリティルール
* 個人情報の扱い

例:

```md
# AGENTS.md

## Required Reading
AIは作業前に以下を読むこと。

- docs/development-method.md
- docs/product/vision.md
- docs/product/glossary.md
- docs/product/business-rules.md
- 対象機能のspec.md
- 対象タスクのTask Contract

## Reading Priority
コンテキスト上限によりすべてを読めない場合は、以下の優先順で読むこと。

1. 対象タスクのTask Contract
2. 対象機能のSpec Contract
3. 対象機能のAcceptance Criteria
4. docs/product/business-rules.md
5. docs/product/glossary.md
6. docs/product/vision.md
7. 関連ADR

上位文書を読めない場合、実装を開始せずに必要情報不足として報告すること。

## Development Rules
- Task Contractがない作業を開始してはいけない
- ただし、初期契約作成時はBootstrap Contractに従う
- Spec Contractに反する実装をしてはいけない
- DBスキーマ変更は人間承認なしに行ってはいけない
- 認証・権限・個人情報関連の変更は人間承認が必要
- 変更後はテスト・型チェック・Lintを実行する
- 仕様変更が必要な場合は実装前に提案する

## Commands
- test: npm run test
- typecheck: npm run typecheck
- lint: npm run lint
```

### 7.2 Product Vision

Product Visionは、プロダクト全体の目的を定義する。

記載する内容:

* 解決する問題
* 対象ユーザー
* 改善する業務
* 成功条件
* 作らないもの

例:

```md
# Product Vision

## Purpose
介護事業所における職員アサインとリスケ業務を効率化する。

## Target Users
- 管理者
- シフト担当者
- ケアマネジャー
- サービス提供責任者

## Problems
- 職員の空き状況確認に時間がかかる
- 病欠時の代替職員探しが属人的
- 連絡履歴が分散している

## Success Criteria
- 代替職員候補を短時間で抽出できる
- 割当変更が即時反映される
- 二重割当を防止できる

## Non-Goals
- 外部カレンダー連携は行わない
- 給与計算は対象外
```

### 7.3 Requirement Contract

Requirement Contractは、要求を契約として定義したものである。

例:

```md
# Requirement Contract

## Requirement ID
REQ-001

## Title
職員候補検索

## Background
病欠や急な予定変更が発生した際、管理者は代替可能な職員を探す必要がある。

## User
管理者

## Need
条件に合う職員候補を短時間で抽出したい。

## Business Rules
- 既に別予定が入っている職員は候補に出さない
- 必要資格を満たさない職員は候補に出さない
- 対応可能エリア外の職員は候補に出さない
- 休暇中の職員は候補に出さない

## Acceptance
- 条件を入力すると候補職員が一覧表示される
- 候補には空き状況、資格、対応エリアが表示される
- 二重割当になる職員は表示されない

## Out of Scope
- Slack通知
- 自動割当
- 給与計算
```

### 7.4 Spec Contract

Spec Contractは、実装可能な粒度まで落とした仕様契約である。

含める内容:

* Feature ID
* 対応するRequirement ID
* 概要
* Actor
* 前提条件
* 入力
* 出力
* 業務ルール
* 権限
* 正常系
* 異常系
* API仕様
* 画面仕様
* Acceptance Criteria
* Out of Scope

例:

```md
# Spec Contract

## Feature ID
F001

## Title
職員候補検索機能

## Related Requirements
- REQ-001

## Summary
管理者が日時・必要資格・対応エリアを指定し、条件に合う職員候補を検索できるようにする。

## Preconditions
- 管理者がログインしている
- 職員情報が登録されている
- 予定情報が登録されている

## Inputs
| 項目 | 必須 | 説明 |
|---|---|---|
| startDateTime | 必須 | 開始日時 |
| endDateTime | 必須 | 終了日時 |
| requiredSkill | 任意 | 必要資格 |
| area | 任意 | 対応エリア |

## Outputs
| 項目 | 説明 |
|---|---|
| staffId | 職員ID |
| staffName | 職員名 |
| skills | 保有資格 |
| availableTime | 空き時間 |
| conflictStatus | 予定重複の有無 |

## Business Rules
- 指定時間帯に既存予定がある職員は除外する
- 指定された資格を持たない職員は除外する
- 指定エリアに対応できない職員は除外する
- 休暇中の職員は除外する
- 退職済み職員は除外する

## Error Cases
| 条件 | 結果 |
|---|---|
| 開始日時が終了日時以降 | バリデーションエラー |
| 未ログイン | 401 |
| 権限なし | 403 |
| サーバーエラー | 500 |

## Acceptance Criteria
- 条件に一致する職員のみ表示される
- 二重割当になる職員は表示されない
- 必須条件が不足している場合はエラーになる
- 権限がないユーザーは検索できない

## Out of Scope
- 候補職員への自動通知
- 職員の自動割当
- 勤務希望の登録
```

### 7.5 WBS

WBSは仕様を作業単位へ分解し、進捗と責任を管理する成果物である。

WBSで管理する内容:

* どの仕様に対応する作業か
* 現在どの段階か
* 誰が担当するか
* AIが担当するか、人間が担当するか
* 人間承認が必要か
* 依存関係
* 完了条件
* 完了証跡

例:

```md
# WBS

## Feature
F001 職員候補検索機能

| WBS ID | タスク | フェーズ | 担当 | 状態 | 承認 | 依存 | 完了条件 |
|---|---|---|---|---|---|---|---|
| WBS-001-001 | 仕様確認 | Definition | Human + AI | Done | 必須 | なし | Spec Contract承認済み |
| WBS-001-002 | DB影響確認 | Design | AI | Review | 必須 | WBS-001-001 | 影響テーブル一覧作成 |
| WBS-001-003 | 検索API設計 | Design | AI | In Progress | 必須 | WBS-001-002 | API仕様作成 |
| WBS-001-004 | 検索API実装 | Build | AI | Not Started | 不要 | WBS-001-003 | テスト成功 |
| WBS-001-005 | 検索画面実装 | Build | AI | Not Started | 不要 | WBS-001-003 | 画面動作確認 |
| WBS-001-006 | 結合テスト | Verify | AI + Human | Not Started | 必須 | WBS-001-004, WBS-001-005 | 受け入れ条件達成 |
```

JSONで管理する場合の例:

```json
{
  "projectId": "project-care-schedule",
  "version": "1.0.0",
  "items": [
    {
      "id": "WBS-001-004",
      "title": "職員候補検索APIの実装",
      "featureId": "F001",
      "phase": "Build",
      "status": "Implementing",
      "ownerType": "AI",
      "ownerRole": "Implementation Agent",
      "reviewer": "Human Developer",
      "humanGateRequired": false,
      "dependencies": ["WBS-001-003"],
      "doneCriteria": [
        "Spec ContractのBusiness Rulesを満たす",
        "正常系テストが通る",
        "異常系テストが通る",
        "型チェックが通る",
        "Lintが通る"
      ],
      "evidence": ["PR", "Test Result", "Review Comment"]
    }
  ]
}
```

### 7.6 Task Contract

Task Contractは、WBS上の1タスクに対する契約である。

AIに直接作業させる場合、Task Contractを必ず作成する。

例:

```md
---
wbsId: WBS-001-004
featureId: F001
size: M
allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**
forbiddenPaths:
  - src/auth/**
  - src/database/schema/**
  - src/billing/**
  - migrations/**
humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
  - openapi/**
requiredChecks:
  - test
  - typecheck
  - lint
  - security
---

# Task Contract

## Title
職員候補検索APIの実装

## Goal
指定された条件に一致する職員候補を検索するAPIを実装する。

## Scope
- 検索条件を受け取る
- 予定重複を判定する
- 必要資格で絞り込む
- 対応エリアで絞り込む
- 休暇中・退職済み職員を除外する
- 検索結果を返す

## Out of Scope
- Slack通知
- 自動割当
- UI実装
- DBスキーマ変更

## Owner
AI Implementation Agent

## Reviewer
Human Developer

## Human Gate
不要

## Dependencies
- WBS-001-003 検索API設計

## Done Criteria
- Spec ContractのBusiness Rulesを満たす
- 正常系テストが通る
- 異常系テストが通る
- 型チェックが通る
- Lintが通る
- 個人情報をログ出力しない
- DBスキーマを変更していない

## Evidence Required
- 実装差分
- テスト結果
- 型チェック結果
- Lint結果
- AIレビュー結果

## Risks
- 予定重複判定の漏れ
- 権限チェック漏れ
- 大量データ時の検索性能低下
```

---

## 8. Task Sizing

Task Contractは、AIが安全に作業できる粒度で作成する。

### 8.1 基本原則

1つのTask Contractは、1つのAIセッションで理解・実装・検証・報告できる単位にする。

### 8.2 サイズ基準

| Size | 目安 | 扱い |
|---|---|---|
| XS | 数分〜30分 | 簡略Taskでよい |
| S | 30分〜半日 | AI向き |
| M | 半日〜1日 | 標準 |
| L | 1〜3日 | 分割推奨 |
| XL | 3日以上 | FeatureまたはEpicとして扱う |

AIに直接実装させるタスクは、原則としてSまたはMにする。

### 8.3 分割条件

以下に該当する場合、タスクを分割する。

* 変更ファイルが10個を超える
* 複数Featureにまたがる
* DB変更とUI変更を同時に含む
* API変更と画面変更を同時に含む
* 認証・権限に影響する
* 仕様の未確定事項が3つ以上ある
* テスト方針が不明
* 1つのAIセッションで読み切れない

### 8.4 コンテキスト制約

AIセッションには、読み込める情報量の上限がある。

Task Contractを作るときは、AIが必ず読むべき情報をTask Contract内に集約する。

Task Contractには、少なくとも以下を含める。

* 対象Feature
* 対象Spec Contractへの参照
* 実装に必要な業務ルールの要約
* 変更してよいファイル範囲
* 変更してはいけないファイル範囲
* 参照必須のADR
* 未確定事項

AIが必要文書を読み切れない場合は、実装を進めず、Handoff PacketまたはBlockerとして記録する。

---

## 9. AIエージェントの役割

実際に複数のAIを使う必要はない。1つのAIに役割を明示して依頼してもよい。

### 9.1 Spec Agent

要求を仕様へ変換する。

主な作業:

* 要求の曖昧さを洗い出す
* 業務ルールを整理する
* Spec Contractを作成する
* Acceptance Criteriaを作成する
* Out of Scopeを明確にする

### 9.2 PM Agent

WBSと進捗を管理する。

主な作業:

* WBS作成
* 依存関係整理
* 状態更新
* ブロッカー抽出
* 承認待ち一覧作成
* リスク一覧作成
* PM向けサマリー作成

PM Agentは状態更新案を作成できる。ただし、Humanのみが許可された状態遷移を確定してはならない。

### 9.3 Architect Agent

設計を支援する。

主な作業:

* アーキテクチャ案作成
* 技術選定支援
* 影響範囲分析
* DB設計案作成
* API設計案作成
* ADR作成

### 9.4 Implementation Agent

Task Contractに基づいて実装する。

主な作業:

* コード実装
* テスト追加
* 型エラー修正
* Lint修正
* 既存コードとの整合性確認

### 9.5 Test Agent

検証を担当する。

主な作業:

* テストケース作成
* 単体テスト作成
* 結合テスト作成
* E2Eテスト観点作成
* 異常系テスト追加
* 回帰テスト確認

### 9.6 Review Agent

成果物をレビューする。

主な作業:

* 仕様準拠確認
* セキュリティ観点の確認
* 破壊的変更の検出
* 不要な変更の検出
* テスト不足の指摘
* ドキュメント更新漏れの指摘

### 9.7 Documentation Agent

ドキュメントを更新する。

主な作業:

* README更新
* AGENTS.md更新
* Spec Contract更新
* WBS更新
* ADR作成
* 用語集更新
* 開発手順更新

---

## 10. AI Role Operation

### 10.1 Single Session Mode

1つのAIセッション内で、Spec Agent、Implementation Agent、Review Agentなどの役割を切り替える方式。

向いているケース:

* 小規模タスク
* 個人開発
* プロトタイプ
* 低リスクな修正

ルール:

* ロール切り替え時は明示する
* Review Agentは批判的に見る
* 重要変更はHuman Reviewを必須とする

Single Session Modeでは、同じAIが実装とレビューを行うため、レビューの独立性が弱くなる。

Review Agentへ切り替える場合は、以下のプロンプトを使う。

```md
あなたはここからAI Review Agentです。

直前の実装を正当化してはいけません。
Spec Contract、Task Contract、Acceptance CriteriaのみをGround Truthとして判断してください。

以下を優先して確認してください。

1. 実装がSpec Contractに反していないか
2. Task ContractのScope外の変更がないか
3. Out of Scopeを実装していないか
4. forbiddenPathsまたはhumanGateRequiredPathsに触れていないか
5. 仕様変更が必要な内容をLevel 0またはLevel 1として扱っていないか
6. テスト、Evidence、Documentation Health Checkが不足していないか

疑わしい場合はApproveせず、Request ChangesまたはNeeds Human Decisionとしてください。
```

### 10.2 Handoff Mode

別セッション、別AI、別担当者に作業を引き継ぐ方式。

Handoff Modeでは、Handoff Packetを必須とする。

```md
# Handoff Packet

## Role From
前工程の役割

## Role To
次工程の役割

## Target Feature
対象Feature

## Target WBS
対象WBS

## Required Documents
次工程が必ず読むべき文書

## Current Decisions
確定済みの判断

## Open Questions
未解決の疑問

## Constraints
制約・禁止事項

## Expected Output
期待する成果物

## Human Gate
人間承認が必要な条件
```

### 10.3 Multi-Agent Mode

複数AIまたは複数担当者で役割を分ける方式。

AI間の引き継ぎは会話ではなく、成果物ファイルを通じて行う。

推奨される流れ:

```text
Spec Agent
  ↓ spec.md

PM Agent
  ↓ wbs.md / task-contract.md

Implementation Agent
  ↓ code / tests / evidence.md

Review Agent
  ↓ review.md

Human
  ↓ approval.md
```

---

## 11. 人間承認ゲート

すべてを人間承認にすると開発速度が落ちる。一方で、すべてをAI任せにすると事故が起きる。

そのため、人間承認が必要な変更と不要な変更を明確に分ける。

### 11.1 人間承認が必須の変更

以下の変更は、必ず人間承認を必要とする。

* 要求変更
* 仕様変更
* 業務ルール変更
* DBスキーマ変更
* マイグレーション追加
* APIの破壊的変更
* 認証方式の変更
* 権限設計の変更
* 個人情報の扱いに関する変更
* セキュリティ設定変更
* 外部サービス連携
* 課金・決済関連
* リリース判断
* スコープ変更
* 納期に影響する変更

### 11.2 原則としてAIに任せてよい変更

以下は、原則としてAIに任せてよい。

ただし、プロジェクト固有の制約がある場合はAGENTS.mdに従う。

* 単体テストの追加
* 軽微なリファクタリング
* 型エラー修正
* Lint修正
* ドキュメントの軽微な更新
* UI文言の軽微な修正
* 既存仕様内のバグ修正
* テストデータ追加

---

## 12. 仕様変更レベル

仕様変更は重要度に応じて3段階に分ける。

### 12.1 Level 0: 実装上の補完

AIが合理的に判断してよい軽微な補完。

例:

* 内部関数名
* 変数名
* テスト名
* 軽微なUI余白
* エラー文言の軽微な調整

条件:

* 業務ルールに影響しない
* API契約に影響しない
* DBに影響しない
* 権限に影響しない
* ユーザーの主要動作に影響しない

対応:

* AIが判断してよい
* Task Notesに記録する

### 12.2 Level 1: 仕様補足

小さな仕様判断だが、後から確認できるようにするもの。

例:

* 検索結果0件時の表示
* 一覧のデフォルト並び順
* 入力文字数上限
* 軽微なバリデーション仕様

対応:

* AIが提案して実装してよい
* Spec ContractのNotesまたはAppendixに追記する
* Review時に人間が確認する

### 12.3 Level 2: 仕様変更

人間承認が必要な変更。

例:

* 業務ルール変更
* DBスキーマ変更
* API変更
* 権限変更
* セキュリティ変更
* 個人情報の扱い変更
* 画面フロー変更
* スコープ変更

対応:

* AIは実装を停止する
* Spec Change Proposalを作成する
* 人間承認後に実装する

仕様変更提案の形式:

```md
# Spec Change Proposal

## Related Feature
F001 職員候補検索機能

## Current Spec
現在の仕様

## Problem
現在の仕様では対応できない問題

## Proposed Change
変更案

## Impact
- API
- DB
- UI
- Tests
- Documentation
- Schedule

## Alternatives
代替案

## Human Decision Required
- Approve
- Reject
- Revise
```

---

## 13. Contract Enforcement

Task Contractは、可能な限り機械的に検証できる形式にする。

CIでは以下を検出する。

* allowedPaths外の変更
* forbiddenPathsへの変更
* humanGateRequiredPathsへの変更
* テスト未実行
* 型チェック未実行
* Lint未実行
* セキュリティ検証未実行
* 仕様変更があるのにSpec Contract更新がない
* DB変更があるのにADRまたは承認記録がない
* API変更があるのにAPI仕様更新がない
* WBS状態が更新されていない
* Evidenceが記録されていない

違反がある場合、PRを通してはならない。

### 13.1 検出可能な違反

CIで検出しやすい違反は以下である。

* forbiddenPathsへの変更
* allowedPaths外の変更
* humanGateRequiredPathsへの変更
* requiredChecksの未実行
* テスト失敗
* 型チェック失敗
* Lint失敗
* API仕様ファイル未更新
* マイグレーション追加時のADR未更新
* Evidenceファイル未作成

### 13.2 検出不能または検出困難な違反

以下はCIだけでは検出困難である。

* AIが仕様変更をLevel 0またはLevel 1として過小評価した
* 業務ルールの解釈が誤っている
* Spec Contract自体が不十分である
* UIフロー変更の意味が業務上大きい
* 個人情報の扱いが文脈上不適切である
* テストは通るがAcceptance Criteriaを満たしていない
* リファクタリングが将来の保守性を下げている
* AIレビューが実装判断を正当化している

検出困難な違反は、Human Reviewで確認する。

Strict Profileでは、検出困難な違反に対してTraceability Matrix、レビュー記録、承認ログを残す。

---

## 14. Verification

Verificationは、実装が契約を満たしているかを確認する工程である。

最低限実施する確認:

* 単体テスト
* 結合テスト
* 型チェック
* Lint
* ビルド
* セキュリティ確認
* 仕様準拠確認
* 変更範囲確認
* ドキュメント更新確認

### 14.1 Security Verification

Verifyフェーズには、Security Verificationを独立工程として含める。

```md
# Security Verification Checklist

## Authentication
- 未ログインで保護APIにアクセスできない
- セッション・トークンの扱いが安全
- 認証処理をTask範囲外で変更していない

## Authorization
- 権限のないユーザーが操作できない
- 権限チェックがフロントエンドだけに依存していない
- 管理者操作はサーバー側で検証している

## Injection
- SQLインジェクション対策がある
- コマンドインジェクションにつながる処理がない
- ユーザー入力を安全に扱っている

## Personal Data
- 個人情報を不要に返していない
- 個人情報をログに出力していない
- エラーメッセージに機微情報を含めていない

## API
- 入力バリデーションがある
- エラー時のレスポンスが過剰な内部情報を含まない
- レート制限や乱用対策が必要か確認した

## Frontend
- XSSにつながるHTML挿入がない
- 外部URLを安全に扱っている
- 秘密情報をクライアントに埋め込んでいない

## Dependencies
- 新規依存ライブラリが妥当
- 不要な依存を追加していない
- 既知の脆弱性チェックを実行した
```

### 14.2 セキュリティ検証コマンド例

プロジェクトの技術スタックに応じて、以下のようなコマンドをSecurity VerificationのEvidenceに記録する。

```text
npm audit
pnpm audit
yarn npm audit
cargo audit
pip-audit
bundle audit
semgrep .
gitleaks detect
```

利用できないコマンドがある場合は、未実行理由をEvidenceに記録する。

---

## 15. Review

レビューでは、コード品質だけでなく、契約違反を確認する。

AIレビュー用プロンプト:

```md
あなたはこのプロジェクトのAI Review Agentです。

以下を基準にレビューしてください。

- Spec Contractに準拠しているか
- Task Contractの範囲外の変更がないか
- 業務ルールに反していないか
- DBスキーマを勝手に変更していないか
- 認証・権限に問題がないか
- 個人情報をログ出力していないか
- テストが十分か
- エラーケースが考慮されているか
- 不要なリファクタリングが含まれていないか
- ドキュメント更新が必要か

出力形式:

## Review Summary
全体評価

## Critical Issues
重大な問題

## Spec Violations
仕様違反

## Scope Violations
Task Contract範囲外の変更

## Security Concerns
セキュリティ懸念

## Test Gaps
不足しているテスト

## Required Fixes
修正必須項目

## Optional Suggestions
任意の改善提案

## Verdict
- Approve
- Request Changes
- Needs Human Decision
```

---

## 16. Evidence管理

Evidenceは、作業が完了条件を満たしたことを示す証跡である。

含める内容:

* テスト結果
* 型チェック結果
* Lint結果
* ビルド結果
* セキュリティ確認結果
* スクリーンショット
* PRリンク
* コミットID
* レビューコメント
* 実行ログ
* 仕様との差分説明
* 更新不要だったドキュメントとその理由

例:

```md
# Evidence

## WBS ID
WBS-001-004

## Test Result
- npm run test: passed
- npm run typecheck: passed
- npm run lint: passed

## Changed Files
- src/features/staff-search/api.ts
- src/features/staff-search/service.ts
- tests/features/staff-search/service.test.ts

## Security Verification
- 個人情報ログ出力なし
- 権限チェック変更なし
- DBスキーマ変更なし

## Documentation
- Spec Contract更新不要。既存仕様内の実装であるため。
- WBS状態をImplementingからAI Reviewへ更新。

## Review
- AI Review: passed
- Human Review: pending
```

---

## 17. Documentation Health Check

ドキュメントはコードと同様に保守対象である。

AIまたは人間が変更を行った場合、以下を確認する。

* 変更内容に対応するSpec Contractが最新である
* WBSの状態が更新されている
* Task ContractのEvidenceが記録されている
* 仕様変更があった場合、Acceptance Criteriaが更新されている
* 設計判断が変わった場合、ADRが作成または更新されている
* APIが変わった場合、API仕様が更新されている
* DBが変わった場合、マイグレーションとADRが更新されている
* 開発ルールが変わった場合、AGENTS.mdが更新されている
* PM向けStatus Reportが必要に応じて更新されている

以下を満たさないタスクはDoneにしてはならない。

* 関連ドキュメントが更新済みである
* 更新不要の場合、その理由がEvidenceに記録されている
* WBS状態が最新である
* Task ContractのEvidenceが記録されている

---

## 18. ADRによる設計判断記録

ADRはArchitecture Decision Recordの略である。

重要な設計判断はADRとして記録する。

ADRに記録すべきもの:

* フレームワーク選定
* DB選定
* 認証方式
* API設計方針
* ディレクトリ構成
* 外部サービス連携方針
* 状態管理方針
* テスト方針

例:

```md
# ADR-0002: 外部カレンダー連携を行わない

## Status
Accepted

## Context
本システムでは、職員の予定管理を扱う。
外部カレンダー連携を行う案もあったが、運用上の制約と情報管理上の懸念がある。

## Decision
本プロジェクトでは、Google Calendar等の外部カレンダー連携は行わない。
予定情報はシステム内部で管理する。

## Consequences
- 外部カレンダーとの同期問題を避けられる
- 権限管理をシステム内で完結できる
- 既存カレンダーとの二重管理が発生する可能性がある
- 将来的に連携する場合は別ADRを作成する
```

---

## 19. Cross-Cutting Task

Feature境界を越える作業は、Cross-Cutting Taskとして管理する。

対象例:

* 共通認証基盤
* APIクライアント共通化
* エラーハンドリング統一
* ログ基盤変更
* パフォーマンス改善
* ディレクトリ構成変更
* UIコンポーネント共通化
* DBアクセス層のリファクタリング

例:

```md
# Cross-Cutting Task Contract

## Task ID
CCT-001

## Title
APIエラーハンドリングの共通化

## Type
Refactoring

## Affected Features
- F001
- F002
- F003

## Goal
APIエラー形式を統一し、フロントエンド側のエラー処理を簡潔にする。

## Scope
- 共通エラー型の追加
- APIレスポンス形式の統一
- 既存APIのエラー返却処理の置換
- 関連テストの更新

## Out of Scope
- 業務ルール変更
- DBスキーマ変更
- 認証方式変更
- UIデザイン変更

## Required Human Gate
必要

## Migration Strategy
1. 共通エラー型を追加
2. 1機能だけで試験導入
3. テスト確認
4. 他Featureへ段階適用

## Done Criteria
- 影響Featureのテストが通る
- API仕様が更新されている
- 既存エラーケースが破壊されていない
- ADRが作成されている
```

### 19.1 CCTの優先度とステータス伝播

Cross-Cutting TaskがFeature作業をブロックする場合、関連FeatureのWBSにもBlockerとして紐付ける。

ルール:

* CCTは専用のWBS IDまたはTask IDを持つ
* 影響するFeature IDを必ず列挙する
* ブロックされるFeature側のWBSにはBlocked理由としてCCT IDを記録する
* Status ReportにはCCT単体の状態と、ブロックされているFeature一覧を表示する
* CCTがDoneになるまで、依存Featureの該当タスクをDoneにしてはならない

Status Reportでの表示例:

```md
## Cross-Cutting Blockers

| CCT ID | Title | Status | Blocking Features |
|---|---|---|---|
| CCT-001 | APIエラーハンドリングの共通化 | Implementing | F001, F002, F003 |
```

---

## 20. ブロッカー管理

作業が進められない場合は、WBS状態をBlockedにする。

Blockedにする条件:

* 仕様が未確定
* 必要な承認がない
* 依存タスクが未完了
* 業務ルールが不明
* 技術的な制約が未解決
* 必要な情報が不足している

記録形式:

```md
# Blocker

## WBS ID
WBS-001-004

## Blocker Type
仕様未確定

## Description
予定重複判定において、移動時間を考慮するか未決定。

## Impact
検索APIの候補抽出ロジックを確定できない。

## Required Decision
移動時間を考慮するかどうか。

## Options
1. 移動時間を考慮しない
2. 一律30分の移動時間を考慮する
3. エリア間移動時間マスタを使う

## Recommended Option
初期リリースでは一律30分を採用する。

## Owner
Human PM

## Status
Waiting for decision
```

---

## 21. リスク管理

AI共同開発ではスピードが速い分、リスクの発見が遅れることがある。

そのため、リスクは明示的に管理する。

```md
# Risk

## Risk ID
RISK-001

## Title
予定重複判定の漏れ

## Description
検索APIで予定重複判定が不十分な場合、二重割当が発生する可能性がある。

## Probability
Medium

## Impact
High

## Mitigation
- 重複判定テストを追加する
- 境界値テストを追加する
- 結合テストで予定重複ケースを確認する

## Owner
Test Agent

## Status
Open
```

---

## 22. PM向け進捗ビュー

PMはコードの詳細よりも、以下を把握する必要がある。

* 現在フェーズ
* 完了済みタスク
* 進行中タスク
* ブロッカー
* 承認待ち
* リスク
* スコープ変更
* リリース可能性

例:

```md
# Status Report

## Date
2026-06-27

## Current Phase
Build / Verify

## Overall Progress
| フェーズ | 進捗 |
|---|---|
| Discovery | 100% |
| Definition | 90% |
| Specification | 80% |
| Design | 70% |
| Build | 45% |
| Verify | 20% |
| Release | 0% |

## WBS Summary
| 状態 | 件数 |
|---|---|
| Done | 28 |
| Implementing | 6 |
| Human Review | 4 |
| Blocked | 2 |
| Not Started | 15 |

## Approval Waiting
- DBスキーマ変更案
- 職員権限モデル
- CSV出力項目

## Blockers
- 予定重複判定ルールが未確定
- 権限ロールの定義が未承認

## Risks
- 検索性能が大量データで低下する可能性
- 業務ルールの例外が未整理

## Next Actions
- 権限モデルを承認する
- 予定重複判定ルールを確定する
- F001の結合テストを開始する
```

---

## 23. 推奨ディレクトリ構成

```text
project-root/
  AGENTS.md
  README.md

  docs/
    development-method.md
    product/
      vision.md
      glossary.md
      stakeholders.md
      business-rules.md

    specs/
      features/
        F001-staff-search/
          requirement.md
          spec.md
          acceptance-criteria.md
          wbs.md
          tasks/
            WBS-001-001.md
            WBS-001-002.md
            WBS-001-003.md

    architecture/
      overview.md
      adr/
        ADR-0001-architecture-policy.md
        ADR-0002-auth-policy.md

    project-management/
      roadmap.md
      milestone.md
      wbs.md
      risks.md
      issues.md
      decisions.md
      status-report.md

    operations/
      dev-commands.md
      test-commands.md
      release-checklist.md

  src/
    ...

  tests/
    ...

  scripts/
    check/
      verify.sh
      verify.ps1
```

### 23.1 WBSの同期ルール

WBSはFeature単位とプロジェクト全体の両方で管理できる。

二重管理による不整合を避けるため、以下を原則とする。

* Feature配下のwbs.mdを正とする
* project-management/wbs.mdは集約ビューとする
* 集約ビューにはFeature WBSのID、状態、依存関係、Blockerのみを転記する
* Feature WBSを更新した場合、必要に応じて集約ビューも更新する
* 状態が異なる場合は、Feature WBSの状態を優先する
* Strict Profileでは、同期漏れをDocumentation Health Checkで確認する

---

## 24. 標準ワークフロー

### 24.1 新機能開発

```text
1. 必要に応じてBootstrap Contractを作成する
2. Product Visionを確認する
3. Requirement Contractを作成する
4. Spec Contractを作成する
5. 人間が仕様を承認する
6. WBSへ分解する
7. Task Contractを作成する
8. AIが実装計画を提示する
9. 実装する
10. Verificationを行う
11. AIレビューする
12. 人間レビューする
13. 必要なHuman Gateを通す
14. Evidenceを記録する
15. Documentation Health Checkを行う
16. Doneにする
```

### 24.2 バグ修正

```text
1. バグ内容を記録する
2. 影響するSpec Contractを特定する
3. 仕様どおりでない場合は修正タスクを作る
4. 仕様自体が不十分な場合は仕様変更提案を作る
5. Task Contractを作る
6. 修正する
7. 再発防止テストを追加する
8. Verificationを行う
9. Evidenceを記録する
10. Doneにする
```

### 24.3 仕様変更

```text
1. 変更理由を記録する
2. Spec Change Proposalを作成する
3. 影響範囲を確認する
4. 人間が承認する
5. Spec Contractを更新する
6. WBSを更新する
7. Task Contractを更新する
8. 実装する
9. Verificationを行う
10. Evidenceを記録する
```

### 24.4 既存プロジェクトへの導入

```text
1. Bootstrap Contractを作成する
2. AGENTS.mdを作成する
3. Product Visionを書く
4. Glossaryを書く
5. 既存機能をFeature単位に分ける
6. 重要FeatureからSpec Contractを書く
7. FeatureごとにWBSを作る
8. 進捗状態を管理する
9. AI作業をTask Contract単位にする
10. Evidenceを残す
11. 定期的にStatus Reportを更新する
```

---

## 25. AIへの標準作業プロンプト

AIに作業を依頼するときは、以下の形式を使う。

```md
あなたはこのプロジェクトのAI Implementation Agentです。

必ず以下を読んでから作業してください。

- AGENTS.md
- docs/development-method.md
- docs/product/glossary.md
- docs/product/business-rules.md
- 対象機能のspec.md
- 対象タスクのTask Contract

すべてを読み切れない場合は、以下の優先順で読んでください。

1. 対象タスクのTask Contract
2. 対象機能のSpec Contract
3. Acceptance Criteria
4. Business Rules
5. Glossary
6. 関連ADR

上位文書を読めない場合は実装を開始せず、Blockerとして報告してください。

今回の対象タスク:

- WBS ID: WBS-001-004
- Feature: F001 職員候補検索機能

作業ルール:

1. Task Contractの範囲外の変更をしないでください。
2. DBスキーマ変更が必要な場合は、実装せずに提案だけしてください。
3. 認証・権限まわりの変更が必要な場合は、実装せずに提案だけしてください。
4. 実装前に変更予定ファイルを列挙してください。
5. 実装後にテスト・型チェック・Lintの結果を報告してください。
6. 仕様変更が必要だと判断した場合は、コードを書く前に止まってください。
7. 最後にEvidenceを作成してください。
```

---

## 26. Definition of Done

本手法におけるDoneは、単にコードが動くことではない。

DoDは運用プロファイルに応じて定義する。

```md
# Lean Definition of Done

- Spec ContractまたはFeature Specを満たしている
- Task Contractを満たしている
- Out of Scopeの作業をしていない
- 変更禁止範囲に触れていない
- 必要なテストが通っている
- Evidenceが最低限記録されている
- 仕様変更が必要な場合、実装前に停止または提案している
```

```md
# Standard Definition of Done

- Spec Contractを満たしている
- Task Contractを満たしている
- Out of Scopeの作業をしていない
- allowedPaths外の変更がない
- forbiddenPathsへの変更がない
- 必要なテストが通っている
- 型チェックが通っている
- Lintが通っている
- ビルドが通っている
- Security Verificationを完了している
- Documentation Health Checkを完了している
- Evidenceが記録されている
- WBS状態が更新されている
- 必要なレビューが完了している
- 必要なHuman Gateが完了している
- 仕様変更がある場合、Spec Contractが更新されている
- 設計判断がある場合、ADRが更新されている
- 既存機能を壊していない
- セキュリティ上の重大な問題がない
```

```md
# Strict Definition of Done

- Standard Definition of Doneをすべて満たしている
- Human Gate記録が残っている
- Traceability Matrixが更新されている
- Change Approval Logが更新されている
- Risk Registerが更新されている
- Release Checklistが更新されている
- 監査ログ方針に反していない
- 検出困難な違反についてHuman Review記録が残っている
```

プロファイルを明示していないプロジェクトでは、Standard Definition of Doneを適用する。

---

## 27. 中核原則

本手法の中核原則は以下である。

```text
仕様でAIを制御する。
WBSで進捗を制御する。
Task Contractで作業範囲を制御する。
CIで契約違反を制御する。
Evidenceで完了判定を制御する。
Human Gateで責任ある判断を制御する。
```

文書は書くだけでは不十分である。可能な限り、CI、チェックリスト、レビュー、Evidenceによって検証する。

AIへの指示は、自然言語だけに閉じず、以下に落とし込む。

* 仕様
* WBS
* Task Contract
* allowedPaths
* forbiddenPaths
* requiredChecks
* Human Gate
* Evidence

これにより、AIを活用しながらも、人間が責任を持てる開発プロセスを実現する。
