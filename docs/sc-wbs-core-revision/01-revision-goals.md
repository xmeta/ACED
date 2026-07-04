# 01. Revision Goals

## 背景

SC-WBS は、AIに作業範囲を契約として与え、差分とEvidenceで完了を判断する開発手法である。

現在の設計は安全性を重視しているが、以下の問題がある。

- AIに渡す文脈が大きくなりやすい。
- YAML/JSONを直接編集する運用に寄りやすい。
- Task Contract、Evidence、Approval、WBS、Registry、Review などを毎回意識すると運用が重い。
- EvidenceやApprovalのスキーマ詳細をAIに読ませると、コストが増え、性能も下がる。
- Full機能を最初から使うと、個人開発や小規模プロジェクトでは過剰になる。

## 改訂後のゴール

### Goal 1: Command-first

人間とAIは、YAML/JSONを直接書かない。

```bash
scwbs task new "スタッフ検索APIを実装"
scwbs start WBS-001
scwbs packet --tiny
scwbs finish
scwbs block "DBスキーマ変更が必要"
scwbs approve WBS-001 --pr 42
```

YAML/JSONは正本としてGit管理するが、人間やAIのUIにはしない。

### Goal 2: Tiny Packet by default

AIに渡す情報は、デフォルトではTiny Packetだけにする。

```text
- taskId
- goal
- allowedPaths
- forbiddenPaths
- stopIf
- checks
- whenDone
- whenBlocked
```

関連仕様やWBS全体は、AIが必要と判断したときだけ段階的に渡す。

### Goal 3: Diff Guard first

安全性は、AIの自己判断ではなく、差分検査で担保する。

```text
AIがルールを完全に覚えていなくても、check-diff が止める。
```

### Goal 4: Evidence without self-stale

Evidenceは、Evidenceファイル自身のコミットでstaleにならない設計にする。

```yaml
subjectHeadCommit: <実装差分のHEAD>
evidenceCommit: <Evidence自身のコミット。任意>
diffHash: <検証対象差分のhash>
```

### Goal 5: Approval scope binding

Approvalは、PR番号だけでなく、承認時点の `headCommit` と `diffHash` に紐づける。

承認後に追加コミットされた場合は、再承認が必要になる。

### Goal 6: WBS optional in Core

CoreではWBS-JSONを必須にしない。

小規模では Task Contract と tasks index だけで始める。
依存関係が増えたらWBS-JSONへ昇格する。

## 非ゴール

この改訂の初期段階では、以下を目指さない。

- 完全なWeb UI
- 複雑なReviewer routing
- Strict Profileの完全実装
- Risk Registerの完全実装
- 監査ログの完全実装
- AIエージェントの自動起動
- WBS-JSON中心の大規模PM機能

## 成功条件

この改訂が成功した状態は以下である。

```text
1. AIは Tiny Packet だけで多くの作業を開始できる。
2. 人間はYAMLを編集せずにタスク作成・承認ができる。
3. AIはEvidenceやApprovalのスキーマを知らなくても完了処理できる。
4. check-diffが範囲外変更を確実に止める。
5. Human Gate対象変更は承認なしで完了できない。
6. EvidenceはEvidence自身のコミットでstaleにならない。
7. Approval後の追加コミットを検出できる。
```

## 設計判断

### Decision 1: Core と Full を分ける

```text
Core = 軽量ガードレール
Full = 大規模プロジェクト管理
```

Coreが安定してからFullへ拡張する。

### Decision 2: YAML/JSONは内部形式

YAML/JSONはGitで管理しやすいので正本として残す。
ただし、人間やAIにはCLIを使わせる。

### Decision 3: AIにはスキーマを読ませない

AIが読むのはTiny Packetと対象ファイルだけにする。
スキーマ検証、Evidence生成、Approval生成はCLIが行う。

### Decision 4: completed化は人間判断

AIは `ready` や `blocked` までは提案できる。
`completed` は、人間の承認または明示操作を必要とする。

