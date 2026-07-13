# 08. Migration Plan From Current SC-WBS To Core

この文書は、既存SC-WBS仕様へ Core 方針を反映するための移行手順である。

## 移行方針

一気に既存仕様を削除しない。まず Core を追加し、CLIとAI運用の入口を Core に寄せる。

```text
Step 1: docs/sc-wbs-core/ を追加
Step 2: READMEにCore運用へのリンクを追加
Step 3: AGENTS.mdを追加
Step 4: CLIに短縮コマンドを追加
Step 5: Evidence/Approvalのcommit/diff設計を修正
Step 6: check-diffをCoreルールに合わせて強化
Step 7: Full/Strict文書を必要時参照に降格
```

導入順は「全部を一度に入れる」ではなく、次の段階増築を前提にする。

```text
Phase 1: Task Contract + Packet + check-diff + Evidence + Human Gate
Phase 2: 軽い索引として tasks/index.yaml
Phase 3: WBS-JSON、Registry、Review Queue、Traceability
```

## 既存仕様への主な変更

### 1. YAML直書きを通常運用から外す

既存仕様ではYAML例を多く示している。これはスキーマ説明としては残してよいが、通常運用はコマンド中心にする。

変更後:

```text
YAML/JSONは正本。
ただし、人間/AIは scwbs コマンドで生成・更新する。
```

### 2. Work Packet既定をTinyにする

既存では relation-depth=1 が既定候補だが、CoreではTinyを既定にする。

```bash
scwbs packet --tiny
```

必要時だけNormal/Deepへ拡張する。

### 3. Evidenceのcommit設計を修正する

既存の `git.headCommit` は、Evidenceファイルのコミットによりstale判定が揺れる。

変更後:

```yaml
git:
  subjectHeadCommit: abc1234
  evidenceCommit: null
  diffHash: sha256:...
```

### 4. Approvalをdiffに紐づける

ApprovalはPR番号だけでなく、承認時点の `headCommit` と `diffHash` に紐づける。

### 5. completion applyは承認を生成しない

`completion apply` は既存Approvalを検証するだけにする。
不足するApprovalを自動でapprovedにしてはいけない。

### 6. Human Gateを種別分離する

```text
preImplementation
completion
release
```

実装前停止と完了承認を混同しない。

### 7. humanGateRequiredPathsをStandard以上でErrorにする

承認なしのHuman Gate対象差分は、PR readyにしてはいけない。

### 8. managedContractPathsを導入する

EvidenceやBlockなどの生成物が `allowedPaths` と衝突しないようにする。

ただし、管理ファイルも手書き自由にはしない。対応コマンドだけが更新する。

### 9. WBS-JSONをCoreでは任意にする

小規模・個人開発ではWBS-JSON必須にしない。
タスク数や依存関係が増えてから導入する。
Core の入口は「WBS管理ツール」より「AI作業ガードレールCLI」として設計する。

## 既存文書の扱い

| 既存文書 | 扱い |
|---|---|
| `overview.md` | Core原則を追記。Fullフローは参照扱い |
| `task-contract.md` | command-firstとCore最小形式を追記 |
| `ai-work-packet.md` | Tiny/Normal/Deep Packetへ更新 |
| `contract-enforcement.md` | check-diffのCoreルールを反映 |
| `evidence-human-gate-review.md` | subjectHeadCommit/diffHashを反映 |
| `operations-profile-and-specs.md` | Core/Full/Strictの関係を明記 |
| `cli-reference.md` | Core短縮コマンドを先頭に追加 |
| `wbs-json.md` | Coreではoptional、Fullではrequiredと明記 |

## 移行完了条件

```text
- AIがAGENTS.mdとTiny Packetだけで通常実装を始められる
- YAML/JSONを手書きしなくてもtask/evidence/approval/blockを生成できる
- scwbs finish がEvidence生成とcheck-diffを統合している
- ApprovalがheadCommit/diffHashに紐づく
- completion applyがApprovalを生成しない
- Human Gate対象差分が承認なしでPR readyにならない
```
