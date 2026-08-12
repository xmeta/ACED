# WBS Conflict Mitigation（WBS競合の緩和）

この文書は、WBS の競合を安全に扱うための方針を日本語で示す。

このnoteは`contracts/wbs/project.wbs.json`のnear-term conflict strategyを定義する。

## 問題

`contracts/wbs/project.wbs.json`はcanonical WBS documentである。single canonical JSON fileはvalidateしやすいが、複数の人間またはAI agentが並行してnode、relation、artifactを追加するとmerge hotspotになり得る。

current projectは当面single canonical fileを維持する。Full distributed WBS supportは有用だが、immediate problemより大きい。

2026-06-30のPR #15 conflictはsecond hotspotを示した。`contracts/tasks/SCWBS-028.yaml`のようなgenerated SC-WBS contract pathは、WBS JSON自体がmergeableでも衝突し得る。高コストなのはtextual mergeではなく、task IDの再割当、Evidenceのrefresh、CIの再実行、PRが再びmergeableであることをGitHubが証明するまでの待機であった。

## Near-Term Strategy（短期戦略）

preferred collaboration unitとしてsemantic change setを使う。

agentはWBS全体をregenerateしてはならない。次のような小さい`wjs` semantic operationを提案する。

```json
{
  "schemaVersion": "0.1.0",
  "targetWbsId": "scwbs",
  "changeSetId": "changeset-add-task-node",
  "author": "ai-agent",
  "reason": "Add planned work package",
  "dryRun": true,
  "operations": [
    {
      "operation": "addNode",
      "node": {
        "id": "node-new-work",
        "parentId": "node-project",
        "code": "1.9",
        "name": "New work package",
        "type": "workPackage",
        "status": "planned"
      },
      "position": {
        "mode": "last"
      }
    }
  ]
}
```

safe workflowは次のとおりである。

```bash
npm run scwbs -- wbs apply change-set.json
npm run scwbs -- check
```

review後にだけ`--force --output contracts/wbs/project.wbs.json`でchangeをapplyする。

final Evidenceをcollectする前、またはPRを開く前に、agentは`origin/main`のviewをrefreshして次を実行する。

```bash
git fetch origin
npm run scwbs -- health
npm run scwbs -- check-diff --task <task-id>
```

`scwbs health`はcurrent branchが`origin/main`よりbehindの場合、および両sideが同じhigh-cost SC-WBS contract pathを異なるcontentで追加した場合にwarningを出す。これらのwarningは、追加のEvidenceまたはCI timeを使う前にstop-and-reassignするsignalとして扱う。

## Merge Assistance Roadmap（merge支援のroadmap）

low-cost implementation pathは次のとおりである。

1. final Evidence collect前にbranchが`origin/main`よりbehindならwarningを出す。
2. 両sideが同じ`contracts/tasks`、`contracts/evidence`、`contracts/approvals`、`contracts/changesets` pathを異なるcontentで追加した場合にwarningを出す。
3. dry-run change-set templateを出力する`scwbs wbs plan`または`scwbs wbs propose` helperを追加する。
4. semantic change setで十分な場合にfull-file WBS rewriteをrejectするvalidationを追加する。
5. non-conflicting change setをcurrent WBSへreplayできるsemantic merge helperを追加する。
6. semantic change-set workflowが不十分だと判明した後にだけdistributed WBS importを検討する。

## Distributed WBS Option（distributed WBSの選択肢）

single-file modelがreal bottleneckになった場合は、後からfeature-level WBS fragmentを導入する。

```text
contracts/wbs/project.wbs.json
contracts/wbs/features/search.wbs.json
contracts/wbs/features/auth.wbs.json
```

main WBSはvalidation entrypointとして残す。fragment supportをStrict workflowで許可する前に、deterministic import order、ID uniqueness rule、relation resolution、artifact resolutionを定義しなければならない。

## Current Rule（現行ルール）

distributed WBSが存在するまでは、すべてのWBS updateで次のruleを守る。

* 小さなchangeを追加するためにWBS全体をrewriteしない。
* semantic operationとdry-run previewを優先する。
* Task Contract作成後はnode IDをstableに保つ。
* WBS content変更後はaffected Task Contract lockをregenerateする。
* `health.git.addedPathCollision`が出た場合は、final Evidenceをcollectする前にtaskをrenameまたはreassignする。
