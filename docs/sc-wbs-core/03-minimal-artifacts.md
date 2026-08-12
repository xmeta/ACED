# 03. 最小artifact

この文書は、SC-WBS Core が内部生成する最小成果物を定義する。

## 原則

```text
YAML/JSONは正本である。
ただし、人間やAIが通常直接編集するUIではない。
```

各成果物は `scwbs` コマンドで生成・更新する。

## ディレクトリ

最小構成:

```text
contracts/
  tasks/
    WBS-001.yaml
  evidence/
    WBS-001.yaml
  approvals/
    WBS-001.yaml
  blocks/
    WBS-001.yaml
```

小規模では、`approvals/` や `blocks/` は必要時だけ生成すればよい。常に全ディレクトリを先に埋める必要はない。

依存管理が必要になった場合:

```text
contracts/
  tasks/
    index.yaml
```

WBS-JSONが必要になった場合:

```text
contracts/
  wbs/
    project.wbs.json
  changesets/
    *.json
```

## Task Contract Core

Task Contract は、AIが実行してよい作業範囲を定義する。Lite/Core では、まず `allowedPaths`、`forbiddenPaths`、`humanGateRequiredPaths`、`stopIf`、`requiredChecks` を最優先で持つ。

最小フィールド:

```yaml
id: WBS-001
type: task-contract
wbsNodeId: node-staff-search
featureId: F-STAFF-SEARCH
branchName: task/WBS-001-staff-search

allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**

forbiddenPaths:
  - src/auth/**
  - src/database/**
  - migrations/**
  - package.json
  - .github/**

humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
  - openapi/**

stopIf:
  - DB schema change is required
  - auth or permission design change is required
  - public API breaking change is required
  - allowedPaths are insufficient
  - business rule is unclear

requiredChecks:
  - test
  - typecheck

doneCriteria:
  - Staff search API satisfies the approved acceptance criteria

evidenceRequired:
  - test-result
  - typecheck-result
```

### Task Contractの注意

- `allowedPaths` は変更してよい最大範囲であり、変更すべき範囲ではない。
- `forbiddenPaths` は常に `allowedPaths` より優先する。
- `humanGateRequiredPaths` に触る差分は、承認なしではPR readyにしてはいけない。
- CLIが生成する `contractLock` v2 はWBS全体hashではなく、対象scopeとglobal policyを分離する。無関係なsibling変更でstaleになりすぎないためである。
- 小さい導入では、Task Contract 自身と対象Specだけを固定できれば十分である。

## Evidence Core

Evidence は、作業がDone条件を満たしたことを示す機械証跡である。長い完了報告より、commit、changedFiles、checks、diff identity を優先する。

最小フィールド:

```yaml
id: EVD-WBS-001
type: evidence
taskId: WBS-001
subjectHeadCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
evidenceCommit: def5678
diffHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

provenance:
  schemaVersion: 1.0.0
  subject:
    commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    treeHash: 0123456789abcdef0123456789abcdef01234567
    diffHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    canonicalization: git-diff-binary-v1
  retention:
    mode: patch-artifact
    locator: repo:contracts/evidence-payloads/WBS-001.patch
    manifestHash: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789

git:
  branch: task/WBS-001-staff-search
  base: origin/main
  baseCommit: def5678
  subjectHeadCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  changedFilesBasis: branch-diff
  diffHash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  pullRequest: "#42"

changedFiles:
  - src/features/staff-search/api.ts
  - tests/features/staff-search/api.test.ts

checks:
  - name: test
    status: passed
    command: npm test
    source: local
  - name: typecheck
    status: passed
    command: npm run typecheck
    source: local

testQuality:
  assertionsAdded: true
  testsDisabled: false
  coverageDecreased: false
```

### Evidenceの注意

`subjectHeadCommit` は Evidence が証明する対象の実装HEADである。
Evidenceファイル自体をコミットするとHEADが変わるため、`subjectHeadCommit` と `evidenceCommit` を分ける。

`diffHash` は、baseからsubjectHeadCommitまでの差分を正規化して計算する。
Approval はこの `diffHash` に紐づける。

`evidence collect` は同じ正規差分を
`contracts/evidence-payloads/<task-id>.patch` に保存する。Evidence、Approval、
Review、Registry、payload自身は正規差分から除外する。`treeHash` はこのpatchを
`baseCommit`へ一時index上で適用して再構築したtreeを指す。したがってsquash後に
元commit objectが取得できなくても、payload hash、diffHash、treeHash、
changedFilesがすべて一致した場合だけsubjectを再検証できる。

## Approval Core

Approval は人間の承認記録である。

```yaml
id: APR-WBS-001
type: approval
taskId: WBS-001
status: approved
approvedBy: human
approvedAt: 2026-07-03T10:00:00+09:00
reason: レビュー済み
pullRequest: "#42"
headCommit: abc1234
diffHash: sha256:...
```

Approval は PR番号だけに紐づけてはいけない。PRに追加コミットされた場合、承認時点の `headCommit` / `diffHash` と一致しなくなるため、再承認が必要である。

## Block Core

Block は、AIが作業継続できない理由を記録する。

```yaml
id: BLK-WBS-001
type: block
taskId: WBS-001
status: blocked
level: 2
category: db
reason: DB schema change is required
requiredHumanDecision: staff_availability table を追加してよいか
createdAt: 2026-07-03T10:00:00+09:00
history:
  - status: blocked
    at: 2026-07-03T10:00:00+09:00
    reason: DB schema change is required
    by: ai-agent
```

AIは危険変更を推測で進めるのではなく、Blockを作る。

## 管理対象Contractのpath

EvidenceやBlockなど、作業に伴い生成される管理ファイルは、通常の `allowedPaths` と別扱いにする。

```yaml
managedContractPaths:
  - contracts/evidence/{taskId}.yaml
  - contracts/blocks/{taskId}.yaml
  - contracts/reviews/{taskId}.yaml
  - contracts/approvals/{taskId}.yaml
  - contracts/changesets/{taskId}-*.json
```

ただし、管理ファイルであっても自由編集は認めない。各ファイルは対応するコマンドだけが生成・更新する。
