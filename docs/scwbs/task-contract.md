# SC-WBS Task Contract

Source: docs/sc-wbs-development.md split reference.

## Block lifecycle

Blockは `contracts/blocks/<task-id>.yaml` に置くライフサイクル記録であり、使い捨ての停止マーカーではない。現在状態は `blocked` または `resolved` で、`history` に各停止・解決イベントの時刻、理由、実行者を保持する。

AIは `ai block` でBlockを作成または再有効化できるが、activeな間は作業を停止し、解決操作を実行してはならない。必要な判断を行った人間だけが次を実行する。

```bash
npm run scwbs -- block resolve --task <task-id> --reason "<判断内容と結果>"
```

解決理由は空にできない。解決後も `createdAt` を保持し、`resolvedAt`、`resolvedBy: human`、`resolution` を記録する。active Blockは `ai next-task` の候補から除外され、`review-queue` の完了条件をblockする。resolved Blockはregistryに監査可能な形で残るが、両queueをblockしない。

## 6. Task Contract

Task Contractは、AIが実装する1作業単位に対する契約である。
1つのTask Contractは、原則として1つのWBS nodeに対応させる。

正本は以下に置く。

```text
contracts/tasks/{task-id}.yaml
```

最小形式は以下である。

```yaml
id: WBS-001-004
type: task-contract
wbsNodeId: node-api-implementation
featureId: F001
branchName: task/WBS-001-004-api-implementation
allowedPaths:
  - src/features/staff-search/**
  - tests/features/staff-search/**
forbiddenPaths:
  - src/auth/**
  - src/database/schema/**
  - migrations/**
humanGateRequiredPaths:
  - src/security/**
  - src/permissions/**
  - openapi/**
requiredChecks:
  - test
  - typecheck
  - lint
submoduleDependencies:
  - path: vendor/dependency
    repository: example/dependency
    pullRequest: "#42"
    upstreamRef: refs/remotes/origin/main
    checks:
      - name: upstream-ci
        status: passed
        url: https://example.com/dependency/actions/runs/123
doneCriteria:
  - Spec Contractを満たしている
  - 正常系と異常系のテストが通る
evidenceRequired:
  - test-result
  - typecheck-result
  - lint-result
contractLock:
  lockVersion: "2"
  wbsScopeRevision: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  wbsGlobalRevision: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
  wbsNodeId: node-api-implementation
  specVersion: 1.2.0
  specRevision: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
  createdAt: 2026-06-27T10:00:00+09:00
```

`wbsNodeId` は `contracts/wbs/project.wbs.json` の `nodes[].id` を指す。
Task Contractは、生成時点のWBS scope hash、global policy hash、Spec versionを `contractLock` として記録する。`wbsScopeRevision` は対象node、ancestor、transitive dependency、produces/consumesで関連するartifactだけを対象にし、無関係なsibling nodeを除外する。`wbsGlobalRevision` はWBS ID、root ID、schema versionとroot `extensions.scwbs` policyを対象にする。

AI Work Packet生成時および `scwbs check` では、これらのrevisionと現在のWBS-JSON、Spec Contractの鮮度を比較する。旧 `wbsRevision` whole-file lockは読み取り互換を維持するが、`task refresh --affected` ではmigration対象として表示する。`task refresh --task <id> --apply` で個別移行し、全更新が意図される場合だけ `task refresh --all --apply` を使う。
WBS nodeのID、親子関係、依存関係、outputs、または参照SpecのversionがTask Contract生成時点から変更されている場合、そのTask Contractはstaleとして扱う。
staleなTask Contractに基づいてAIは実装してはならない。実装前にTask Contractを再生成するか、人間の承認を受けてlockを更新する。
Task Contractのlockを生成するには以下を実行する。

```bash
npm run scwbs -- task lock --task WBS-001-004
```

`allowedPaths` は変更してよい最大範囲であり、変更すべき範囲ではない。
`forbiddenPaths` と `humanGateRequiredPaths` は `allowedPaths` より優先する。

submoduleのgitlinkを変更するTaskは、`submoduleDependencies` にpath、upstream repository、依存PR、merge targetのremote ref、確認済みcheckを記録する。`upstreamRef` を省略した場合は `origin/HEAD`、`origin/main`、`origin/master` の順に存在するrefを選ぶ。submodule内部の許可pathは、たとえば `vendor/dependency/src/**` のようにrootからの完全なpathで `allowedPaths` に列挙する。`check-diff` はEvidenceが収集したnested changed filesにも通常と同じpath規則とHuman Gateを適用する。

## Required check coverage

リポジトリ固有のpath-to-check規則は `contracts/check-coverage.yaml` に置く。

```yaml
rules:
  - id: wjs-tests
    paths: [wjs, wjs/**]
    requires: [test:wjs]
  - id: integration-tests
    paths: [src/commands/**, tests/integration/**]
    requires: [test:integration]
```

`check-diff` と `finish` は実変更pathに必要なcheckがTask Contractの `requiredChecks` に無い場合に失敗する。packetは `allowedPaths` から予測した必要checkと不足checkを表示する。

例外が必要な場合はTask Contractへ理由付きwaiverを明記する。

```yaml
checkCoverageWaivers:
  - check: test:integration
    reason: External integration environment is temporarily unavailable.
```

waiverは現在のEvidence scopeに対するHuman Approvalがなければ有効にならない。AIはApprovalをapprovedにしてはならない。

AIはTask Contractの範囲外を変更してはならない。範囲外変更が必要な場合は、実装を止めてSpec Change ProposalまたはHuman Gateを要求する。

Task Contractの推奨粒度は以下である。

* 1つのPRで完了できる
* 1つの主要成果物に対応する
* `allowedPaths` が3〜5グループ以内である
* Stop Conditionsを明確に判定できる
* 人間が15分〜30分でレビューできる差分である

危険領域に触る作業は分離する。UI変更、API変更、DB変更、権限変更、マイグレーション追加を1つのTask Contractに混ぜてはならない。

WBS nodeからTask Contract草案を生成するには以下を実行する。

```bash
npm run scwbs -- task generate --node node-api-implementation --task WBS-001-004
```

生成されたTask Contractは草案である。人間が `allowedPaths`、`humanGateRequiredPaths`、`doneCriteria` を確認し、必要に応じて修正してから `task lock` を実行する。

---
