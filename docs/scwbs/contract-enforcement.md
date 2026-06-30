# SC-WBS Contract Enforcement

Source: docs/sc-wbs-development.md split reference.

## 8. Contract Enforcement

`scwbs check` は、SC-WBSの契約違反を検出する。

```bash
npm run scwbs -- check
```

検出対象は以下である。

* WBS-JSONが不正
* registryの参照先が存在しない
* Task Contractの `wbsNodeId` がWBS nodeに存在しない
* Task Contractの `contractLock` が現在のWBS revisionまたはSpec versionと整合していない
* WBS nodeの `outputs` が存在しないartifactを指している
* Done相当nodeにEvidenceがない
* EvidenceにrequiredChecksがない
* Human Gate対象変更に承認記録がない

Git差分はTask単位で検査する。

```bash
npm run scwbs -- check-diff --task WBS-001-004
npm run scwbs -- check-diff --task WBS-001-004 --base origin/main
```

`check-diff` はPR readiness用の検査として、既定で `origin/main...HEAD` のbranch diffを使う。base branchが異なる場合は `--base <ref>` で明示する。作業ツリー上のWBS直編集ガードは `scwbs check` 側で引き続き検査する。

判定ルール:

| 条件 | 結果 |
|---|---|
| `allowedPaths` 外の変更 | Error |
| `forbiddenPaths` への変更 | Error |
| `humanGateRequiredPaths` への変更 | WarningまたはHuman Gate要求 |
| 明示許可されていないメタファイル変更 | Error |
| `project.wbs.json` 変更時にsemantic operation change setがない | Error |
| `contracts/changesets/*.json` が `wjs` operations schemaに適合しない | Error |
| 現在のGit branchがTask Contractの `branchName` と一致しない | Error |
| 対象Task ContractのEvidenceが存在しない | Error |

CIでは、Errorがある場合にPRを通してはならない。
PRを開く前に `npm run scwbs -- evidence collect --task <task-id>` を実行し、`contracts/evidence/<task-id>.yaml` を追加または更新してから `scwbs check-diff --task <task-id>` を通す。

メタファイルは、AIがpath制約や検証環境を迂回するために変更できるため、既定で強い制約を受ける。
代表例は以下である。

* `package.json`
* `package-lock.json`
* `tsconfig.json`
* `vitest.config.ts`
* `.gitignore`
* `.github/**`

これらを変更するTask Contractは、対象ファイルを `allowedPaths` または `humanGateRequiredPaths` に明示しなければならない。
明示されていない場合、`scwbs check-diff` はErrorとして扱う。

`scwbs health` は、契約ファイルとEvidence metadataから運用健全性のdriftを検出する。

```bash
npm run scwbs -- health
```

`scwbs check` が構文、参照、存在確認を扱うのに対し、`scwbs health` は運用健全性を扱う。現行実装の代表的な検出対象は以下である。

* Evidenceの信頼度が低い
* Evidenceのcommitが欠けている、またはGitで確認できない
* Evidenceの `git.headCommit` が現在のHEADと一致しない
* Evidenceの `git.changedFilesBasis` が欠けている
* branch diff基準のEvidenceに `git.base` または `git.baseCommit` が欠けている
* EvidenceのchangedFilesがTask Contractのpath制約と整合していない
* Human Gate対象のEvidenceに承認記録がない
* registry上のRequirement ContractやSpec Contractにstatusがない
* Spec Contractにversion相当の情報がない
* Task Contractに `contractLock` がない
* テストファイルを変更したEvidenceに `testQuality` metadataがない
* Evidenceの `testQuality.assertionsAdded` が `false` である
* Evidenceの `testQuality.testsDisabled` が `true` である
* Evidenceの `testQuality.coverageDecreased` が `true` である

現行の `scwbs health` は、テスト差分のAST解析、assertion数の自動比較、coverage reportの直接解析は行わない。これらは `testQuality` metadataに記録された内容を検査する。

---

Review待ち候補を一覧するには `scwbs review-queue` を使う。
```bash
npm run scwbs -- review-queue
```

このコマンドは少なくとも次を候補として表示する。
* Evidence が存在し、依存が完了していれば human review に進める task
* Evidence が存在するが、未完了の dependsOn があるため completed に進めない task
* Human Gate 対象 path を Evidence が変更しているのに approval 記録がない task
* Task Contract または Evidence に branch / PR 情報がある場合、その情報
* review に必要な branch / PR 情報が不足している場合、その warning
* taskごとの `suggestedAction`
* review候補数、依存block数、PR metadata不足数などの簡易summary

Task Contractごとにbranchを分ける運用では、`1 Task Contract = 1 branch = 1 review unit` を基本とする。
`scwbs check-diff --task <task-id>` は、現在のGit branchがTask Contractの `branchName` と一致しない場合にErrorとし、別Taskのbranchで誤って実装を進めることを防ぐ。
