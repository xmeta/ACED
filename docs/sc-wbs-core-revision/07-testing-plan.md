# 07. Testing Plan

この文書は、SC-WBS Core改訂のテスト計画である。

## テスト方針

```text
安全性の中核である check-diff / finish / approval scope を重点的にテストする。
CLIの出力は、人間向けとJSON向けの両方を確認する。
AIが誤操作した場合に止まることをテストする。
```

## テスト分類

| 種類 | 対象 |
|---|---|
| Unit test | path matcher, diffHash, schema validation, stop preset |
| Integration test | task new -> packet -> finish -> check-diff |
| Git fixture test | branch, diff, rename, delete, binary |
| CLI snapshot test | human output / AI packet output |
| Policy test | approvalなしHuman GateがErrorになること |
| Regression test | Evidence self-stale問題、Approval stale問題 |

## unit test

### path matcher

テストケース:

```text
- POSIX path
- Windows path
- glob `**`
- allowedPaths一致
- forbiddenPaths優先
- humanGateRequiredPaths一致
- managedContractPaths一致
- rename
- delete
```

期待:

```text
forbiddenPaths > humanGateRequiredPaths > managedContractPaths > allowedPaths
```

### diffHash

テストケース:

```text
- 同一diffは同一hash
- 改行コード差分は正規化される
- ファイル順序が変わっても安定する設計にするかを決める
- binary fileはblob hashで表現される
```

### Evidenceの検証

テストケース:

```text
- requiredChecksが揃っている
- requiredChecksが不足している
- failed checkがある
- diffHashが一致する
- diffHashが違う
- subjectHeadCommitが存在しない
```

### Approvalの検証

テストケース:

```text
- approved + scope一致 = pass
- requestedのみ = error
- approvedだがdiffHash不一致 = error
- approvedだがheadCommit不一致 = error
- approvedByなし = error
- approvedAtなし = error
```

## integration test

### 成功経路

```bash
scwbs task new "スタッフ検索APIを実装" --paths src/features/staff-search/** --checks test
scwbs start WBS-001
scwbs packet --task WBS-001 --tiny
# fixtureで許可pathだけ変更
scwbs finish --task WBS-001
scwbs check-diff --task WBS-001
```

期待:

```text
- Evidenceが生成される
- check-diffがpassする
- Tiny Packetが短い
```

### forbidden path

fixture:

```text
migrations/001_add_table.sql を変更
```

期待:

```text
- check-diffがError
- fixCommandに scwbs block が出る
```

### human gate path

fixture:

```text
src/security/policy.ts を変更
```

期待:

```text
- ApprovalなしならError
- requestedのみならError
- approved + scope一致ならPass
- approved + scope不一致ならError
```

### Evidence self-stale regression

手順:

```text
1. 実装差分を作る
2. scwbs finish でEvidence生成
3. EvidenceをコミットしてHEADを進める
4. check-diffを実行
```

期待:

```text
Evidence自身のコミットだけではstaleにならない。
```

### Approval stale regression

手順:

```text
1. PR差分を作る
2. scwbs approve で承認
3. 追加コミットで差分を変える
4. check-diffを実行
```

期待:

```text
Approval scope stale Errorになる。
```

## CLI outputのテスト

### Human向けoutput

エラー出力には必ず以下が含まれる。

```text
- ERROR code
- Task
- Reason
- Fix
```

### JSON output

`--json` では以下が含まれる。

```text
- ok
- errors[]
- warnings[]
- fixCommand
```

### Tiny Packet output

Tiny Packetは以下を満たす。

```text
- 50行以内を目標
- YAML schema説明を含まない
- allowed / forbidden / stopIf / checks / whenDone / whenBlocked を含む
```

## test fixture

推奨fixture構成:

```text
test-fixtures/
  simple-project/
    package.json
    src/features/staff-search/api.ts
    tests/features/staff-search/api.test.ts
    contracts/
  forbidden-change/
  human-gate-change/
  evidence-self-stale/
  approval-stale/
```

## CI check

最低限:

```bash
npm test
npm run typecheck
npm run lint
```

SC-WBS自身のdogfood:

```bash
scwbs finish
scwbs check-diff
```

## 受け入れ基準

MVPの受け入れ基準:

```text
- task newでTask Contractを生成できる。
- packet --tinyが50行以内の作業カードを出せる。
- finishがchecks、Evidence、check-diffを実行できる。
- forbiddenPaths変更を止められる。
- humanGateRequiredPaths変更をApprovalなしで止められる。
- Evidence自身のコミットでstaleにならない。
- Approval後の追加コミットを検出できる。
- すべてのErrorにfixCommandがある。
```
