# SC-WBS AI Work Packet

Source: docs/sc-wbs-development.md split reference。

このlegacy referenceは日本語でmaintainし、command nameとschema fieldは変更しない。

## 7. AI Work Packet

AIに実装を依頼するときは、長い文書一式をそのまま読ませるのではなく、`scwbs` でAI Work Packetを生成する。

```bash
npm run scwbs -- ai packet --task WBS-001-004 --relation-depth 1
```

AI Work Packetには以下を含める。

* AIの役割
* 対象Task Contract
* 対応WBS node
* 関連relations
* outputs artifacts
* requiredChecks
* allowedPaths
* forbiddenPaths
* humanGateRequiredPaths
* Stop Conditions

AIはWork Packetを作業時の優先コンテキストとして扱う。
AI Work Packetは、対象Task Contractを最優先コンテキストとし、関連情報は作業判断に必要な範囲へ絞る。
既定では、relationsの展開範囲は対象WBS nodeからdepth=1までとする。
depth=1には、親node、直接の子node、直接dependsOn、直接blocks、同一親配下の直近の兄弟nodeを含める。
depth=2以上の展開は、Task ContractまたはCLI引数で明示された場合のみ許可する。
Work Packetが大きくなる場合、`scwbs` は本文全体を含めるのではなく、要約、artifact参照、または該当箇所へのパスを優先する。
AIが追加コンテキストを必要と判断した場合は、実装前に不足コンテキストを明示して要求する。

Stop Conditionsに該当する場合、AIは実装せずに停止する。

代表的なStop Conditions:

* DBスキーマ変更が必要
* 認証・権限変更が必要
* API契約の破壊的変更が必要
* Business Ruleが不足している
* allowedPaths外の変更が必要
* 仕様変更レベル判断に迷う場合はLevel 2として扱う必要がある
* Human Gate対象変更はLevel 0またはLevel 1に見えても停止する必要がある

---
