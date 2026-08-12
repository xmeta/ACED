# WJSの操作と検証

このrepositoryは`wjs/`をcanonical WBS-JSON implementationとして扱う。

## 正本

WBS source of truthは次である。

```text
contracts/wbs/project.wbs.json
```

このfileは次に従う。

```text
wjs/schema/wbs-json.schema.json
```

## Change-Setのルール

WBS changeは次の配下にsemantic operation change setとして提案する。

```text
contracts/changesets/*.json
```

小さなsemantic operationで足りる場合に、WBS全体をhand-editまたはregenerateしてはならない。`addNode`や`addRelation`など、`wjs/schema/wbs-operations.schema.json`のoperationを使う。

## WBSをvalidateする

```bash
npm --prefix wjs run validate -- ../contracts/wbs/project.wbs.json
npm run scwbs -- wbs validate
```

`scwbs wbs validate`と`scwbs check`は内部で`wjs/tools/validate.ts --wbs`を使う。

## Operationをvalidateする

```bash
npm --prefix wjs run validate -- --operations ../contracts/changesets/change-set.json
```

`scwbs check-diff`は`contracts/changesets/*.json`を`wjs/tools/validate.ts --operations`でvalidateする。

## Diffの強制

`scwbs check-diff --task <task-id>`は次のWBS関連ruleをenforceする。

- `contracts/wbs/project.wbs.json`が変更された場合、diffに少なくとも1つの`contracts/changesets/*.json`がある。
- `contracts/changesets/*.json`がWJS operations schemaにpassする。
- current Git branchがTask Contractの`branchName`と一致する。
- WBS nodeをAI implementation workで`completed`にしない。

## Apply preview

previewとreviewにはdry-run change setを使う。

```json
{
  "schemaVersion": "0.1.0",
  "targetWbsId": "scwbs",
  "changeSetId": "example-change",
  "reason": "Add implementation task",
  "dryRun": true,
  "operations": []
}
```

governing TaskがHuman Gate approvalを要求する場合は、work開始前にそのrequirementをTask Contractへ記録し、apply前にapprovalを得る。

```bash
npm run scwbs -- wbs apply contracts/changesets/change-set.json --force --output contracts/wbs/project.wbs.json
```

`wbs apply`はWBSとoperation documentをvalidateするが、Task IDを受け取らずApproval recordもinspectしない。したがってHuman Gateは、governing Taskの`humanGateRequiredPaths`がcanonical WBS pathにmatchする場合に`check-diff`だけがenforceする。WJS apply内部のunconditional checkではない。
