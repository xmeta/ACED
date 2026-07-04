# 06. Validation Design

この文書は、SC-WBS Coreの検証設計を定義する。

## 検証の中心思想

```text
AIにルールを全部覚えさせない。
AIが間違えても、ツールが差分で止める。
```

そのため、Coreでは `check-diff` と `finish` を最重要機能とする。

## 検証対象

| 検証 | 主なコマンド | 目的 |
|---|---|---|
| Task validation | `task new`, `start` | Task Contractが安全に作られているか |
| Path validation | `check-diff` | allowed/forbidden/gate違反を検出 |
| Evidence validation | `finish`, `check-diff` | Evidenceが差分とchecksを証明しているか |
| Approval validation | `check-diff`, `approve` | 承認scopeが現在差分と一致するか |
| WBS validation | optional | WBS changesetが実差分を再現するか |

## `check-diff` の検証順序

```text
1. Task Contractを取得する
2. 現在branchを確認する
3. base/head commitを解決する
4. changedFilesを収集する
5. pathを正規化する
6. managedContractPathsを分類する
7. allowedPaths外変更を検査する
8. forbiddenPaths変更を検査する
9. humanGateRequiredPaths変更を検査する
10. Evidence存在と内容を検査する
11. Approval scopeを検査する
12. WBS changeset再現性を検査する
13. CheckReportを出力する
```

## Path validation

### ルール

```text
forbiddenPaths > humanGateRequiredPaths > managedContractPaths > allowedPaths
```

優先順位の意味:

- `forbiddenPaths` に一致したら、allowedPathsに含まれていてもError。
- `humanGateRequiredPaths` に一致したら、Approvalが必要。
- `managedContractPaths` はCLI生成物のみ許可。
- それ以外の変更は `allowedPaths` に含まれる必要がある。

### 判定表

| 条件 | 結果 |
|---|---|
| forbiddenPathsに一致 | Error |
| humanGateRequiredPathsに一致しApprovalなし | Error |
| humanGateRequiredPathsに一致しApproval scope不一致 | Error |
| humanGateRequiredPathsに一致しApproval scope一致 | Pass |
| managedContractPathsに一致し許可操作 | Pass |
| managedContractPathsに一致し禁止操作 | Error |
| allowedPathsに一致 | Pass |
| どれにも一致しない | Error |

## managedContractPaths validation

EvidenceやBlockなどのCLI生成物が `allowedPaths` 外変更として落ちないようにする。
ただし、AIがApprovalを捏造できないよう、ファイル種別ごとに許可操作を分ける。

| Path | 生成コマンド | 許可されるstatus | AI可否 |
|---|---|---|---|
| `contracts/evidence/{taskId}.yaml` | `finish` | n/a | 可 |
| `contracts/blocks/{taskId}.yaml` | `block` | `blocked` | 可 |
| `contracts/approvals/{taskId}.yaml` | `request-approval` | `requested` | 可 |
| `contracts/approvals/{taskId}.yaml` | `approve` | `approved` | 人間のみ |

検証方法:

```text
- Approval fileのstatusがapprovedの場合、approvedByとapprovedAtとscopeを必須にする。
- AI実行モードではapproved recordの新規作成をErrorにする。
- check-diffではapproved recordのscopeが現在差分と一致するか確認する。
```

## Evidence validation

Evidenceは自己申告ではなく、差分とchecksに結びつく必要がある。

### 必須検証

```text
- taskIdが対象Task Contractと一致する
- subjectHeadCommitが存在する
- baseCommitが存在する
- diffHashが現在差分から再計算した値と一致する
- changedFilesが現在差分と一致する
- requiredChecksがすべて記録されている
- failed checkがない
```

### Evidenceがstaleになる条件

```text
- subjectHeadCommitが現在の検証対象headと違う
- diffHashが現在差分と違う
- changedFilesが現在差分と違う
- requiredChecksが不足している
```

### Evidenceがstaleにならない条件

Evidenceファイル自体をコミットしたことでHEADが進んだだけならstaleにしない。

検証は以下で行う。

```text
subjectHeadCommit が現在ブランチの祖先であり、
Evidence生成時のdiffHashがPR対象差分と一致しているかを見る。
```

## diffHash設計

### 目的

ApprovalとEvidenceを、PR番号やタスクIDではなく実際の差分に紐づける。

### 入力

```text
- baseCommit
- subjectHeadCommit
- normalized git diff
```

### 正規化方針

```text
- path separatorを `/` に統一
- diff headerの揺れを最小化
- 行末はLFに統一
- バイナリ差分はfile path + blob hashで表現
```

### 出力

```text
sha256:<hex>
```

## Approval scope validation

Approvalは以下のscopeに紐づく。

```yaml
scope:
  pullRequest: "#42"
  headCommit: abc1234
  diffHash: sha256:...
```

### Pass条件

```text
- statusがapproved
- approvedByが存在する
- approvedAtが存在する
- scope.headCommitが現在PRのheadと一致する、または承認対象headとして到達可能
- scope.diffHashが現在差分のdiffHashと一致する
```

### Error条件

```text
- Approvalがない
- statusがrequestedのまま
- scopeがない
- diffHashが違う
- headCommitが違う
- approvedByがない
- approvedAtがない
```

## Human Gate validation

Human Gate対象は、Standard以上ではWarningではなくErrorにする。

### 判定対象

```text
- humanGateRequiredPathsに一致する変更
- Stop Conditionに該当するBlockがある
- DB/API/Auth/Permission/Security関連path変更
- 仕様変更Level 2
```

### ルール

```text
Human Gate対象変更 + approved Approvalなし = Error
Human Gate対象変更 + requested Approvalのみ = Error
Human Gate対象変更 + approved Approval + scope一致 = Pass
Human Gate対象変更 + approved Approval + scope不一致 = Error
```

## WBS changeset validation

Coreでは任意。
Full連携時に有効化する。

### 目的

WBS changesetが存在するだけでなく、実際のWBS差分を再現することを保証する。

### 検証

```text
base project.wbs.json
  + contracts/changesets/*.json を順に適用
  = HEAD project.wbs.json
```

これが一致しない場合はError。

## CheckReport形式

Human-readable:

```text
ERROR SCWBS_APPROVAL_SCOPE_STALE
Task: WBS-001
Reason: Approval diffHash does not match current diff.
Fix:
  scwbs approve WBS-001 --pr 42 --reason "reviewed updated diff"
```

JSON:

```json
{
  "ok": false,
  "errors": [
    {
      "code": "SCWBS_APPROVAL_SCOPE_STALE",
      "taskId": "WBS-001",
      "severity": "error",
      "message": "Approval diffHash does not match current diff.",
      "fixCommand": "scwbs approve WBS-001 --pr 42 --reason \"reviewed updated diff\""
    }
  ],
  "warnings": []
}
```

## Severity

| Severity | 意味 | CI |
|---|---|---|
| error | 完了・PR ready不可 | fail |
| warning | 注意。Profileによってfail可 | configurable |
| info | 情報 | pass |

## fixCommand設計

すべてのErrorには `fixCommand` を出す。

ただし、危険操作は自動修復しない。

| Error | fixCommand |
|---|---|
| Evidence missing | `scwbs finish` |
| forbidden path | `scwbs block "<reason>"` |
| human gate required | `scwbs request-approval <task-id>` |
| approval stale | `scwbs approve <task-id> --pr <n>` |
| branch mismatch | `scwbs start <task-id>` |
| check failed | テスト修正後 `scwbs finish` |

