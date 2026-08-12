# 03. Detailed Design

この文書は、SC-WBS Core改訂の詳細設計である。


## Domain Model

### TaskContract

AIが実行してよい範囲を表す。

最小概念:

```text
id
title
goal
branchName
allowedPaths
forbiddenPaths
humanGateRequiredPaths
stopIf
checks
lock
```
### Evidence

作業差分がチェックを満たしたことを表す。

重要なのは、Evidence自身のコミットではなく、検証対象差分を指すこと。

```text
subjectHeadCommit
baseCommit
diffHash
changedFiles
checks
```

### Approval

人間承認を表す。

Approvalは、単なるタスクIDではなく、承認対象scopeに紐づく。

```text
status
approvedBy
approvedAt
scope.headCommit
scope.diffHash
```

### Block

AIまたは人間が、作業を止める理由を表す。

```text
reason
kind
stopCondition
requestedDecision
```

### Packet

AIに渡す作業カード。

Tiny Packetは短いテキスト出力を第一形式とする。

## Repository Layer

YAML/JSONの読み書きを担当する。

```text
contracts/tasks/*.yaml
contracts/evidence/*.yaml
contracts/approvals/*.yaml
contracts/blocks/*.yaml
contracts/tasks/index.yaml
contracts/wbs/project.wbs.json
contracts/changesets/*.json
```

Repositoryは以下を守る。

```text
- 既存ファイルを暗黙に上書きしない。
- 書き込み前にschema validationを行う。
- 可能ならatomic writeする。
- 生成物にはformatを統一する。
```
