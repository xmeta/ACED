# 08. Migration Plan

この文書は、既存SC-WBSプロジェクトへCore改訂を反映する手順である。

## 方針

既存仕様を削除しない。

```text
Full仕様は残す。
Coreを入口に追加する。
```

これにより、既存のWBS-JSON、registry、review、approval運用を壊さず、軽量なAI作業サイクルだけを先に導入できる。

## 移行ステップ

## Step 1: 文書を追加する

追加先:

```text
docs/sc-wbs-core-revision/
```

追加するもの:

```text
00-index.md
01-revision-goals.md
02-implementation-plan.md
03-detailed-design.md（概要）と `03a`〜`03d`（責務別詳細）
04-cli-design.md
05-data-model.md
06-validation-design.md
07-testing-plan.md
08-migration-plan.md
09-ai-agent-guidelines.md
```

ルート `README.md` には以下を追記する。

```md
## 軽量Coreワークフロー

AIに長い仕様全体を読ませず、短いコマンドとTiny Packetで運用する場合は、
`docs/sc-wbs-core-revision/00-index.md` を参照してください。
```

## Step 2: AGENTS.mdを更新する

AI向けには、Full仕様ではなくCore運用を先に読ませる。

追加するルール:

```text
- YAML/JSONを手書きしない。
- Task/Evidence/Approval/BlockはCLIで生成する。
- AIにはTiny Packetを渡す。
- 危険変更が必要なら scwbs block を使う。
- 完了時は scwbs finish を使う。
- Human approvalをAIが生成しない。
```

## Step 3: CLI aliasを追加する

既存コマンドを壊さず、短いCoreコマンドを追加する。

| 新Coreコマンド | 既存/内部処理 |
|---|---|
| `scwbs packet --tiny` | `ai packet` の軽量版 |
| `scwbs finish` | checks + evidence collect + check-diff |
| `scwbs block` | `ai block` + block record |
| `scwbs approve` | `approval approve` の短縮版 |
| `scwbs request-approval` | `approval request` の短縮版 |
| `scwbs next` | 既存 `next` をCore優先順位に調整 |

## Step 4: Evidence modelを移行する

既存Evidenceの `headCommit` 相当を、次へ移行する。

```yaml
subjectHeadCommit: <検証対象の実装HEAD>
evidenceCommit: null
diffHash: sha256:...
```

移行コマンド案:

```bash
scwbs migrate evidence --write
```

dry-run:

```bash
scwbs migrate evidence
```

### 移行時の注意

- 既存の `git.headCommit` は残してもよい。
- 新規Evidenceでは `subjectHeadCommit` を正とする。
- `health` は現在HEAD一致ではなく、diffHash一致を優先する。

## Step 5: Approval scopeを追加する

既存Approvalにscopeがない場合、stale扱いまたは再承認要求にする。

```yaml
scope:
  pullRequest: "#42"
  headCommit: abc1234
  diffHash: sha256:...
```

移行方針:

| 状態 | 対応 |
|---|---|
| PR番号とcommitを復元できる | scopeを補完する |
| PR番号のみ | warningにする |
| 何も復元できない | 再承認要求 |

## Step 6: managedContractPathsを導入する

Task Contractの `allowedPaths` とEvidence生成が衝突しないように、Core設定に追加する。

```yaml
managedContractPaths:
  - contracts/evidence/{taskId}.yaml
  - contracts/blocks/{taskId}.yaml
  - contracts/approvals/{taskId}.yaml
```

ただし、Approval approvedは人間のみ作成可とする。

## Step 7: Human Gate判定をErrorへ寄せる

Standard以上では、`humanGateRequiredPaths` 変更 + ApprovalなしをErrorにする。

旧仕様にWarning運用がある場合は、Lean/Core限定にする。

## Step 8: completion applyを安全化する

既存の `completion apply` がApprovalを生成する挙動を持つ場合は見直す。

新方針:

```text
completion apply は approved Approval を検証するだけ。
missing approved record を自動生成しない。
```

もし一括承認が必要なら、別コマンドに分ける。

```bash
scwbs approve-many --tasks WBS-001,WBS-002 --pr 42 --reason "reviewed"
```

ただし、これは人間専用である。

## Step 9: WBS optional運用を追加する

小規模プロジェクトでは `contracts/tasks/index.yaml` だけで運用できるようにする。

WBSが存在する場合:

```text
WBSを正本にする。
```

WBSが存在しない場合:

```text
tasks/index.yaml を軽量正本にする。
```

将来、以下で昇格できるようにする。

```bash
scwbs wbs promote-from-tasks
```

## Step 10: AI Packetの既定をTinyにする

既存の `ai packet` がdepth=1を既定にしている場合、CoreではTinyを既定にする。

```bash
scwbs packet --task WBS-001
```

これは以下と同じ。

```bash
scwbs packet --task WBS-001 --tiny
```

関連情報が必要な場合だけ明示する。

```bash
scwbs packet --task WBS-001 --normal
scwbs packet --task WBS-001 --deep
```

## 互換性ポリシー

### 壊してはいけないもの

```text
- 既存Task Contractの読み込み
- 既存Evidenceの読み込み
- 既存approval request/approveコマンド
- WBS-JSON正本運用
- registry検証
```

### 変更してよいもの

```text
- 新規Evidenceの推奨フィールド
- Core用短縮コマンドの追加
- check-diffのHuman Gate判定強化
- healthのstale判定改善
```

### deprecated候補

```text
- AIに長いWork Packetを既定で渡す挙動
- Approvalをcompletion applyで暗黙生成する挙動
- Evidenceの現在HEAD一致だけを見るstale判定
```

## 移行の完了条件

```text
- READMEからCore文書へリンクされている。
- AGENTS.mdがCore運用を優先している。
- scwbs packetの既定がTinyまたはTiny相当になっている。
- scwbs finishでEvidence生成とcheck-diffが統合されている。
- EvidenceがsubjectHeadCommit/diffHashを持つ。
- Approvalがscope.diffHashを持つ。
- managedContractPathsが導入されている。
- Human Gate対象差分が承認なしでPassしない。
```
