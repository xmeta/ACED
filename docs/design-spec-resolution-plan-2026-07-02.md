# SC-WBS Design And Specification Resolution Plan

作成日: 2026-07-02

この文書は `docs/design-spec-issues-2026-07-02.md` で整理した設計・仕様上の問題に対する解決方針である。実装コードの変更ではなく、今後の仕様変更・WBS変更・コマンド実装に落とせる粒度の設計案をまとめる。

## 方針

問題の中心は、SC-WBSの考え方が文書にはある一方で、いくつかの判断がまだ契約artifactやCLI検査に接続されていない点である。解決は大きな再設計ではなく、次の4つの契約面を足すことで進める。

1. 作業バックログを表すWBS nodeを復活させる。
2. 仕様変更を記録するSpec Change Proposalを追加する。
3. Profileごとの必須条件をCLI検査へ接続する。
4. Review独立性とSpec freshnessを機械的に確認できるmetadataへ落とす。

## 1. WBS lifecycleの修正

### 問題

現在のWBSはrootを含む既存nodeがすべて `completed` であり、`ai next-task` が提示できる `planned` nodeがない。その一方で、設計監査、仕様変更、Risk Register、Review独立性などの後続作業は存在する。

### 仕様変更案

WBSに次のworkPackageを追加する。

```json
{
  "id": "node-governance-maintenance",
  "parentId": "node-project",
  "code": "1.10",
  "name": "Governance and specification maintenance",
  "type": "workPackage",
  "status": "planned",
  "outputs": [
    "artifact-contracts",
    "artifact-methodology"
  ],
  "acceptanceCriteria": [
    "Recurring audit, specification, and governance work has a non-completed WBS target.",
    "Spec change, risk, review independence, and profile enforcement artifacts are defined before strict enforcement is claimed.",
    "Maintenance tasks can be discovered by scwbs ai next-task without reusing completed nodes."
  ]
}
```

root nodeの扱いも明確化する。

| Rule | Decision |
|---|---|
| root `completed` | project全体が完了した時だけ許可する |
| root `progressPercent < 100` | root `completed` と同時に存在してはならない |
| completed nodeへの新規Task Contract | 原則禁止。例外はEvidence backfillやauditで、Task Contractに理由を書く |
| maintenance / audit work | dedicated planned nodeに紐づける |

### 実装タスク案

- WBS changesetで `node-governance-maintenance` を追加する。
- root `node-project` を `inProgress` または `planned` に戻すか、`progressPercent` を整合させる。これはHuman decisionが必要。
- `scwbs health` に「completed node + progressPercent < 100」「completed nodeへの新規Task Contract」をwarningとして追加する。
- `task generate` はcompleted nodeを対象にした場合にwarningを出す。

## 2. Spec Change Proposalの追加

### 問題

Level 2仕様変更はHuman Gateで止める方針になっているが、止めた後に何を提出するかが未定義である。

### 新artifact

保存先:

```text
contracts/spec-changes/{change-id}.yaml
```

最小形式:

```yaml
id: SCP-SCWBS-001
type: spec-change-proposal
status: proposed
targetSpec: SPEC-SCWBS-METHOD
currentVersion: 0.1.0
proposedVersion: 0.2.0
taskId: SCWBS-040
level: 2
summary: Define Spec Change Proposal artifact and validation flow.
rationale:
  - Level 2 changes currently stop work but have no canonical proposal artifact.
affectedPaths:
  - docs/scwbs/evidence-human-gate-review.md
  - docs/scwbs/operations-profile-and-specs.md
  - contracts/specs/SPEC-SCWBS-METHOD.yaml
approval:
  required: true
  status: requested
risks:
  - Existing tasks may need contract lock refresh after the spec version changes.
```

Status:

| Status | Meaning |
|---|---|
| `proposed` | 提案済み、未承認 |
| `approved` | Humanが承認し、対応するSpec更新を進めてよい |
| `rejected` | 採用しない |
| `superseded` | 別提案に置き換えた |

### CLI検査案

- `scwbs check` は `contracts/spec-changes/*.yaml` のschemaを検証する。
- `status: approved` には `approvedBy` と `approvedAt` を必須にする。
- `level: 2` の変更がSpec source pathに入る場合、承認済みSCPまたはHuman approvalを要求する。
- Registry typeに `spec-change` を追加する。

## 3. Profile enforcementの接続

### 問題

Profileは既に `contracts/wbs/project.wbs.json` の `extensions.scwbs.profile` にあり、`scwbs profile show/set` で操作できる。しかし、ProfileごとのEvidenceやReview要件はまだ検査に接続されていない。

### 仕様変更案

Profileごとの最小要件を次のように固定する。

| Profile | Evidence | Review | Human Gate | Risk |
|---|---|---|---|---|
| Lean | local checkで可 | self-review可 | 対象pathのみ | 任意 |
| Standard | local check + provenance必須 | independent-ai-review以上 | approval record必須 | 重要変更のみ |
| Strict | CI source必須 | human-review必須 | approved record必須 | Risk Register必須 |

Evidence trust levelは `checks[].source` から判定する。

| Trust | Condition |
|---|---|
| Level A | すべてのrequired checkが `source: ci` で、`runId` または `url` がある |
| Level B | required checkが `source: local` で、`command` と `executedAt` がある |
| Level C | 手入力またはsource不明 |

### CLI検査案

- `health` はprofileを読み、Evidence trustがprofile要件に満たない場合にwarningを出す。
- `check` はStrictでHuman Gate approvalやRisk Registerが欠ける場合にerrorにする。
- StandardではReview recordがない、または `reviewProfile: self-review` の場合にwarningを出す。
- Strictでは `reviewProfile: human-review` 以外をerrorにする。

## 4. Risk Registerの追加

### 問題

Strict profileはRisk Registerを前提にしているが、artifact形式が未定義である。

### 新artifact

保存先:

```text
contracts/risks/{risk-id}.yaml
```

最小形式:

```yaml
id: RISK-SCWBS-001
type: risk
status: open
severity: high
owner: human-maintainer
relatedTask: SCWBS-040
relatedSpec: SPEC-SCWBS-METHOD
summary: Strict profile is claimed before strict validation exists.
impact: Users may rely on controls that are only documented as policy.
mitigation:
  - Connect profile metadata to health and check.
  - Require CI evidence for Strict tasks.
reviewBy: 2026-07-31
```

Status:

| Status | Meaning |
|---|---|
| `open` | 未解決 |
| `mitigated` | 対策済みだが監視対象 |
| `accepted` | Humanがリスク受容 |
| `closed` | 解消済み |

### CLI検査案

- Registry typeに `risk` を追加する。
- Strict profileでLevel 2 SCPまたはHuman Gate対象変更がある場合、関連Riskがないとwarningにする。
- `risk.status: accepted` は `approvedBy` と `approvedAt` を必須にする。

## 5. Review independenceの明確化

### 問題

Review recordは存在するが、独立性を判断するためのmetadataが不足している。

### Review schema拡張案

```yaml
id: RVW-SCWBS-040
type: review
taskId: SCWBS-040
status: requested
reviewProfile: independent-ai-review
reviewer:
  kind: ai
  model: gpt-5
  sessionId: 019f...
  sameSessionAsImplementation: false
groundTruth:
  - contracts/tasks/SCWBS-040.yaml
  - contracts/evidence/SCWBS-040.yaml
```

独立性ルール:

| Profile | Allowed review |
|---|---|
| Lean | `self-review`, `independent-ai-review`, `human-review` |
| Standard | `independent-ai-review`, `human-review` |
| Strict | `human-review` |

`sameSessionAsImplementation: true` のreviewは、Profile判定ではself-reviewとして扱う。

## 6. Spec freshnessの強化

### 問題

Spec Contractは `sourcePaths` と `version` を持つが、source pathの内容変更がいつversion更新や再承認を必要とするかが曖昧である。

### Spec Contract拡張案

```yaml
id: SPEC-SCWBS-METHOD
type: spec-contract
featureId: F-SCWBS-DOGFOOD
status: approved
version: 0.2.0
sourcePaths:
  - docs/sc-wbs-development.md
sourceRevisions:
  - path: docs/sc-wbs-development.md
    sha256: sha256:...
approvedBy: human-maintainer
approvedAt: 2026-07-02T00:00:00+09:00
supersedes: 0.1.0
```

freshness rule:

- `sourcePaths` の内容が変わったら、原則としてSpec Contractはstale。
- 誤字修正など意味を変えない変更はEvidence notesに理由を書けばversion据え置き可。
- Level 1以上の仕様補足はpatch versionを上げる。
- Level 2仕様変更はSCP承認後にminor version以上を上げる。

### CLI検査案

- `task lock` は `sourceRevisions` をlockに含める。
- `check` はSpec `sourceRevisions` と実ファイルhashの差分をwarningまたはerrorにする。
- `task refresh` はSCPまたはapprovalがある場合だけSpec lock refreshを許可する。

## 7. Documentation ownershipの整理

### 問題

分割ドキュメントは読みやすいが、どのartifactの正本仕様がどのdocにあるかが曖昧になりやすい。

### 追加する表

`docs/scwbs/README.md` に次のownership tableを追加する。

| Artifact / rule | Canonical document |
|---|---|
| WBS lifecycle | `evidence-human-gate-review.md` |
| WBS operation workflow | `wbs-json.md`, `wjs-operations-validation.md` |
| Task Contract | `task-contract.md` |
| Evidence | `evidence-human-gate-review.md` |
| Review / Approval | `evidence-human-gate-review.md` |
| Profile / Spec Contract | `operations-profile-and-specs.md` |
| Spec Change Proposal | `operations-profile-and-specs.md` after artifact is introduced |
| Risk Register | `operations-profile-and-specs.md` after artifact is introduced |
| Known gaps | `../implementation-gaps.md` |

`docs/sc-wbs-development.md` の重複リンクも合わせて削除する。

## 実装順序

### Phase 1: WBSと文書の土台

1. Human GateつきWBS changesetで `node-governance-maintenance` を追加する。
2. root nodeのstatus/progress整合ルールを文書化する。
3. `docs/scwbs/README.md` にartifact ownership tableを追加する。
4. `docs/sc-wbs-development.md` の重複リンクを修正する。

### Phase 2: Spec Change Proposal

1. `contracts/spec-changes/*.yaml` のschemaを定義する。
2. registry type `spec-change` を追加する。
3. `scwbs check` にSCP検証を追加する。
4. Level 2仕様変更のworkflowをHuman Gate docsへ接続する。

### Phase 3: ProfileとReview

1. `health` をprofile-awareにする。
2. Review metadataに `reviewer` と `sameSessionAsImplementation` を追加する。
3. Standardでself-reviewをwarning、Strictでnon-human reviewをerrorにする。
4. Evidence trust levelを`health`に表示する。

### Phase 4: RiskとSpec freshness

1. `contracts/risks/*.yaml` のschemaを定義する。
2. Strict profileでRisk Registerを要求する条件を追加する。
3. Spec `sourceRevisions` を追加する。
4. `task lock` / `task refresh` をSpec source hashに対応させる。

## 最初に切るべきTask Contract

最初の実装タスクは、WBSの作業置き場を作る小さなHuman Gateタスクにする。

```yaml
id: SCWBS-040
type: task-contract
wbsNodeId: node-project
featureId: F-SCWBS-GOVERNANCE
branchName: codex/scwbs-040-governance-maintenance-node
allowedPaths:
  - contracts/changesets/SCWBS-040-governance-maintenance-node.json
  - contracts/tasks/SCWBS-040.yaml
  - contracts/evidence/SCWBS-040.yaml
  - contracts/approvals/SCWBS-040.yaml
  - contracts/registry.yaml
humanGateRequiredPaths:
  - contracts/wbs/project.wbs.json
requiredChecks:
  - test
  - typecheck
  - build
doneCriteria:
  - WBS has a non-completed governance maintenance node.
  - Root status and progressPercent are made consistent by explicit human decision.
  - Follow-up governance tasks can target the new node.
```

このタスクはWBS正本を変えるため、AIが直接進めるのではなく、changeset dry-runとHuman approvalを先に置くべきである。

## 判断

今すぐ大きな再設計は不要である。まずWBS上の作業置き場を復旧し、そのうえでSCP、Risk、Review independence、Spec freshnessを順にartifact化するのが最小コストである。これにより、現在は文書ポリシーに留まっている判断を、Task Contract、Evidence、Review、Registry、`check` / `health` の検査対象へ段階的に移せる。
