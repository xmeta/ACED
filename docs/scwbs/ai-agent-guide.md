# AI Agentガイド

このguideは、不要なmethodology contextを読み込まず、draft specをcurrent ruleと混同せずにAI agentが`scwbs`を使う方法を示す。

## 優先順位

instructionが衝突する場合は、次の順序を使う。

1. `AGENTS.md`
2. active `contracts/tasks/<task-id>.yaml`
3. そのtask向けに生成されたpacket
4. `docs/scwbs/`配下のcurrent command doc
5. `docs/sc-wbs-core/`配下のCore reference doc
6. `docs/sc-wbs-core-revision/`配下のdraft revision doc

Task Contractがdraftのimplementまたはintegrateを明示的に要求しない限り、`docs/sc-wbs-core-revision/`をcurrent behaviorとして扱わない。

## 実装AIチェックリスト

edit前に次を行う。

1. `AGENTS.md`を読む。
2. `contracts/tasks/<task-id>.yaml`を読む。
3. current branchが`branchName`と一致することを確認する。
4. modify予定のfileを列挙する。
5. そのfileを`allowedPaths`、`forbiddenPaths`、`humanGateRequiredPaths`と照合する。

Useful command:

```bash
npm run scwbs -- task start <task-id>
```

task contextが不足する場合:

```bash
npm run scwbs -- packet --task <task-id> --tiny
```

または:

```bash
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
```

既定ではdocs tree全体を読まない。

## 停止条件

次のいずれかが必要なら、implementationをstopしてblockする。

- `allowedPaths`外のfile
- `forbiddenPaths`配下のfile
- 未承認の`humanGateRequiredPaths`
- DB schemaまたはmigration
- authenticationまたはpermission change
- breaking API change
- 不明確なbusiness rule
- personal dataまたはsecurity setting change
- external service、billing、release、deploymentのdecision
- 契約済みでないspec-level judgment

Block command:

```bash
npm run scwbs -- ai block --task <task-id> --reason "<reason>"
```

best-effort assumptionを置いて継続してはならない。

## 完了チェックリスト

implementationがcompleteに見えるだけではDoneではない。required check、Evidence、diff validationがcompleteして初めてDoneである。

Typical sequence:

```bash
npm test
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
git status --short --branch
```

implementation changeをcommitしてからEvidenceをcollectする。

```bash
npm run scwbs -- evidence collect --task <task-id>
```

Evidenceまたはregistry fileがimplementation commit後に追加された場合は、そのmetadataを別commitにする。

Final gate:

```bash
npm run scwbs -- check-diff --task <task-id>
```

Evidence収集後にsubject diffを変更したcommitがある場合はEvidenceを再生成する。

## Review AIチェックリスト

implementerのsummaryだけでreviewしてはならない。Ground Truthは次である。

- Task Contract
- packet
- Spec Slice / acceptance criteria（存在する場合）
- actual branch diff
- Evidence
- Approval scope

review question:

- すべてのchanged fileがTask Contractに適合するか。
- implementationが`forbiddenPaths`に触れていないか。
- Human Gate approvalが必要だったか。
- Evidenceがfinal subject commitとchanged fileを記述するか。
- required checkがpassしたか。
- riskに対してtestが適切か。
- branchがmetadataを追加したのにregistryを更新していない状態ではないか。

不明な場合はapproveせず、human reviewerへfindingを報告する。`review approve`、`review changes-requested`、`review close`は`--actor human`を要求するhuman-only transitionであり、AIはそのidentityをclaimして実行してはならない。

code fixではなくHuman Decisionが必要ならblockする。

```bash
npm run scwbs -- ai block --task <task-id> --reason "<reason>"
```

## 優先するcommand

```bash
npm run scwbs -- next
npm run scwbs -- task start <task-id>
npm run scwbs -- packet --task <task-id> --tiny
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- check
npm run scwbs -- registry rebuild --check
npm run scwbs -- evidence collect --task <task-id>
npm run scwbs -- check-diff --task <task-id>
npm run scwbs -- review-queue
```

SC-WBS commandはserialに実行する。実行前にTypeScript outputをbuildするため、parallel実行すると互いに干渉し得る。

## してはならないこと

- `git diff`だけでtask validityを判断しない。
- Task Contractがcontractまたはregistry updateを許可しない限り、YAML/JSON contract fileを手編集しない。
- Approvalを`approved`にしない。
- human-only actorで`review approve`、`review changes-requested`、`review close`を実行しない。
- WBS nodeを直接completeしない。
- `contracts/wbs/project.wbs.json`を直接編集しない。canonical WBSは`contracts/changesets/`配下のchangesetを`npm run scwbs -- wbs apply contracts/changesets/<file> --force --output contracts/wbs/project.wbs.json`でapplyして更新する。changesetなしのWBS editは`scwbs check`と`scwbs check-diff`が`wbs.changeset.required`でfailする。
- current CLI docと異なるfuture Core shorthandをdraft docから使わない。
- `next`がplanned taskをsuggestしただけで`review-queue`を無視しない。
