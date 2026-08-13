# scwbs CLIリファレンス

Status: legacy/detail reference。

このpageはresponsibility-based indexである。current taskに必要な最小のreferenceを読む。

- [Core checkとnavigation](cli-core-checks.md)
- [TaskとEvidenceのlifecycle](cli-task-evidence.md)
- [Approvalとrisk boundary](cli-approval-risk.md)
- [WBS、GitHub、required check](cli-wbs-github.md)
- [Mutation、read-only command、output](cli-mutation-output.md)

command example、JSON contract、Human-only boundary、proposal statusはlinked detail pageに残る。current workは引き続き`AGENTS.md`、active Task Contract、`docs/sc-wbs-core/00-index.md`から始める。

## Risk Acceptance の aggregate scope fingerprint

`risk accept` は、最初に見つかった Task Evidence ではなく、Risk の全 linked scope を canonical sort した `scopeFingerprint` を Human-only acceptance に保存する。構成要素は次のとおりである。

- Task: Task ID、Evidence の `subjectHeadCommit`、`diffHash`
- Spec: Spec ID、Spec version、Spec file の `sha256:` revision
- Requirement: `(specId, specVersion, requirementId, canonical requirement content)` の `sha256:` revision

`risk show --json` と `risk list --json` は `currentScopeFingerprint`、`acceptedScopeFingerprint`、`scopeConstituents`、`scopeComplete`、`scopeIssues` を返す。Evidence、Spec、Requirement が欠落・不正・曖昧な場合は `scopeComplete: false` となり、Acceptance は valid にならない。

新しい受理の確認文字列は次の形式である。

```text
CONFIRM TTY RISK <risk-id> <scopeFingerprint>
```

旧 `subjectHeadCommit` / `diffHash` だけを持つ acceptance は、Task 1件だけの task-only scope に限って互換評価する。複数 Task、Spec、Requirement を含む legacy acceptance は stale として、人間による aggregate fingerprint の再受理が必要になる。
