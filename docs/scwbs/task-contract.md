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

## Authority baseline

`check-diff` はworktree側のTask Contractだけを権限根拠にしない。`origin/main` とHEADのmerge-baseにある契約をbaselineとし、次のauthority fieldsを比較する。

- `allowedPaths`
- `forbiddenPaths`
- `humanGateRequiredPaths`
- `requiredChecks`
- `managedContractPaths`
- `checkCoverageWaivers`

同じTaskがこれらを変更しても、新しい値で同じbranchを自己検証することはできない。変更を有効にするには、現在のEvidence scopeに一致するHuman Approval、または既存の `node-governance-maintenance` Taskが別Taskの契約pathを明示的にscopeへ含めて変更する独立provenanceが必要になる。`contractLock` のWBS/Spec revision refreshだけはauthority変更ではない。

base側に契約がない新規Taskでは、契約・index・registryなど宣言済み `managedContractPaths` だけを含む最初のcommitをtrust rootとして使う。この初回契約はversion 2 lock、自身のmanaged path、標準Human Gate、`wjs/**` boundary、baseline checksを持ち、repository-wide既定globやcreation-time waiverを含めてはならない。契約が未commit、実装と同じcommit、または初回commit後にauthority fieldsが書き換えられた場合は拒否する。

authority比較が必要なbranchでbase refやmerge-baseを解決できない場合、およびshallow cloneではfail-closedになる。履歴を取得してから再実行する。

submoduleのgitlinkを変更するTaskは、`submoduleDependencies` にpath、upstream repository、依存PR、merge targetのremote ref、確認済みcheckを記録する。`upstreamRef` を省略した場合は `origin/HEAD`、`origin/main`、`origin/master` の順に存在するrefを選ぶ。submodule内部の許可pathは、たとえば `vendor/dependency/src/**` のようにrootからの完全なpathで `allowedPaths` に列挙する。`check-diff` はEvidenceが収集したnested changed filesにも通常と同じpath規則とHuman Gateを適用する。

## Required check coverage

リポジトリ固有のpath-to-check規則は `contracts/check-coverage.yaml` に置く。

```yaml
implementationRoots: [src/commands, src/core]
rules:
  - id: wjs-tests
    classification: behavior-critical
    rationale: WJS changes use the dedicated WJS suite.
    paths: [wjs, wjs/**]
    requires: [test:wjs]
  - id: core-types-unit-only
    classification: unit-only
    rationale: Shared declarations have no runtime behavior.
    paths: [src/core/types.ts]
    requires: [test]
  - id: core-workflow-safety-integration
    classification: behavior-critical
    rationale: Git, Evidence, Approval, Human Gate, Registry, and Contract Lock enforcement need workflow regression coverage.
    paths: [src/core/git.ts, src/core/human-gate.ts]
    requires: [test:integration]
```

`implementationRoots` を設定したpolicyでは、root配下の各実装ファイルは明示的なruleへ分類する。新しいcommand/core moduleが未分類なら、`npm run scwbs -- check -- --json` は `checkCoverage.unclassified` をpathごとに列挙して失敗する。`classification` と `rationale` は、behavior-criticalなworkflow実装とunit-onlyで十分な純粋型定義を区別する。広い `src/core/**` / `src/commands/**` ruleは、新規moduleの未分類検出を回避してしまうため使わない。

`check-diff` と `finish` は実変更pathに必要なcheckがTask Contractの `requiredChecks` に無い場合に失敗する。実変更が未分類ならwaiverでは通らず、先にpolicy分類が必要になる。packetは `allowedPaths` からの予測と `origin/main` からの実差分の両方について、必要check・不足check・未分類implementation pathを表示する。

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
