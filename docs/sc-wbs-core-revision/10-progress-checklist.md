# 10. Progress Checklist

この文書は、SC-WBS Core 改訂の進捗を確認するためのチェックリストである。

目的は、実装計画を読まなくても「何が終わっていて、何が残っているか」を短時間で把握できるようにすることである。

## 使い方

- 作業開始時にこのチェックリストを見る。
- 完了した作業だけ `[x]` にする。
- 実装途中の項目は `[ ]` のままにし、必要なら行末に短いメモを書く。
- チェックを付ける前に、該当するテストとドキュメント更新も確認する。
- AIエージェントには、この文書全体ではなく、対象マイルストーンの節だけを渡す。

## 文書統合チェック

- [x] CHECKLIST.md を SC-WBS Core 改訂作業の短い進捗入口として追加した。
- [x] `docs/sc-wbs-core/` と `docs/sc-wbs-core-revision/` の優先順位を明記した。
- [x] 次期Core改訂案の短縮コマンド例が現行 ACED CLI の実装済みコマンドと混同されないようにした。

## 完了判定の共通ルール

各項目は、次を満たした場合だけ完了にする。

```text
1. 実装が存在する
2. CLIから実行できる
3. 失敗時に安全側へ倒れる
4. テストがある
5. エラー時に次の行動が表示される
6. 既存コマンドを壊していない
7. AIに読ませる文脈が増えすぎていない
```

## 進捗サマリー

| Milestone | 目的 | 状態 | 完了条件 |
|---|---|---|---|
| M0 | 現状整理と互換レイヤー | 完了 | 既存CLIとCore CLIの対応が明確 |
| M1 | Core Task Lifecycle | 実装中 | YAML直書きなしでTask作成からPacket生成まで可能 |
| M2 | Finish / Evidence / Diff Guard | 実装中 | `finish` でEvidence生成と差分検査ができる |
| M3 | Human Gate / Approval Scope | 実装中 | 危険変更を止め、承認をdiffに紐づけられる |
| M4 | WBS Optional / Full Integration | 未着手 | WBSなしでも動き、WBSありでも互換 |
| M5 | Review / Spec Change / Full Enhancement | 未着手 | Core上にFull機能を安全に戻せる |

状態は次のいずれかにする。

```text
未着手 / 実装中 / レビュー待ち / 完了 / 保留
```

---

# M0. 現状整理と互換レイヤー

目的:

```text
既存SC-WBSを壊さず、Core CLIを追加する。
```

## M0 チェックリスト

- [x] M0-001: 既存CLIコマンドを一覧化した
- [x] M0-002: 既存CLIの入力、出力、生成ファイルを整理した
- [x] M0-003: Core CLIとの対応表を作成した
- [x] M0-004: 既存コマンドをdeprecatedにするか、aliasにするかを決めた
- [x] M0-005: `npm run scwbs -- ...` の後方互換を維持する方針を決めた
- [x] M0-006: `scwbs ...` 直実行時の解決方法を決めた
- [x] M0-007: 既存のTask Contract / Evidence / Approvalを読み込めることを確認した
- [x] M0-008: 破壊的変更を含まない移行方針をREADMEに追記した

## M0 完了条件

- [x] 既存ユーザーが従来コマンドを使い続けられる
- [x] Core CLIの入口が明確になっている
- [x] 既存仕様とCore仕様の関係が説明されている

---

# M1. Core Task Lifecycle

目的:

```text
YAML直書きなしでTask作成、作業開始、Tiny Packet生成、次作業確認ができる。
```

対象コマンド:

```bash
scwbs task new
scwbs start
scwbs packet --tiny
scwbs next
```

## M1 チェックリスト

- [x] M1-001: `scwbs task new "作業名"` を実装した
- [x] M1-002: `--paths` から `allowedPaths` を生成できる
- [x] M1-003: `--forbid` から `forbiddenPaths` を生成できる
- [x] M1-004: `--gate` から `humanGateRequiredPaths` を生成できる
- [x] M1-005: `--checks` から `requiredChecks` を生成できる
- [x] M1-006: `--stop` から `stopIf` を生成できる
- [ ] M1-007: 引数不足時に対話式で補完できる
- [x] M1-008: 既存taskと衝突しないtaskIdを採番できる
- [x] M1-009: titleから安全なbranch名を生成できる
- [x] M1-010: 既存Task Contractを暗黙に上書きしない
- [x] M1-011: WBSなし運用では `contracts/tasks/index.yaml` を更新できる
- [ ] M1-012: WBSあり運用では直接WBSを書き換えず、必要ならchangeset draftを生成できる
- [x] M1-013: `scwbs start <task-id>` でpre-flightを表示できる
- [x] M1-014: `start` がbranch、lock、path制約、checks、stopIfを表示できる
- [x] M1-015: `scwbs packet --task <task-id> --tiny` を実装した
- [x] M1-016: Tiny Packetが原則50行以内に収まる
- [x] M1-017: Tiny Packetにスキーマ説明や長文仕様を含めない
- [x] M1-018: Tiny Packetに `finish` と `block` の次コマンドを表示する
- [x] M1-019: `scwbs next` が次の作業候補を表示できる
- [x] M1-020: `next` が blocked / missing evidence / failed check / planned task を優先順に扱える

## M1 テストチェック

- [x] `task new` の正常系テストがある
- [ ] taskId衝突時のテストがある
- [x] 既存Task Contractを上書きしないテストがある
- [x] Tiny Packetの最大行数に関するテストがある
- [x] `start` のbranch不一致検出テストがある
- [x] `next` の優先順位テストがある

## M1 完了条件

- [x] 新規タスクをYAML手書きなしで作れる
- [x] AIに渡すTiny Packetが短く、作業に必要な情報だけを含む
- [x] 既存Task Contractを読み込んで利用できる

---

# M2. Finish / Evidence / Diff Guard

目的:

```text
作業完了時に、checks、Evidence生成、差分検査を1コマンドで実行する。
```

対象コマンド:

```bash
scwbs finish
scwbs check-diff
```

## M2 チェックリスト

- [x] M2-001: branch名または引数からtaskIdを推定できる
- [x] M2-002: taskId推定に失敗した場合、安全に停止しfixCommandを出す
- [ ] M2-003: Check Catalogを定義した
- [x] M2-004: `requiredChecks` をCheck Catalogに解決できる
- [x] M2-005: `finish` がrequiredChecksを実行できる
- [x] M2-006: check失敗時にEvidenceを成功扱いにしない
- [x] M2-007: `base...HEAD` のchangedFilesを収集できる
- [x] M2-008: `--base <ref>` を指定できる
- [x] M2-009: `subjectHeadCommit` をEvidenceに記録できる
- [x] M2-010: `baseCommit` をEvidenceに記録できる
- [x] M2-011: `diffHash` を生成できる
- [x] M2-012: Evidenceファイル自身のコミットでstale判定にならない
- [x] M2-013: `changedFiles` をEvidenceに記録できる
- [x] M2-014: `checks` のstatus、command、executedAtを記録できる
- [x] M2-015: `--pr <number>` をEvidenceに記録できる
- [x] M2-016: `allowedPaths` 外変更をErrorにできる
- [x] M2-017: `forbiddenPaths` 変更をErrorにできる
- [ ] M2-018: `humanGateRequiredPaths` 変更で承認なしの場合Errorにできる
- [ ] M2-019: `managedContractPaths` を例外として扱える
- [x] M2-020: Evidence、Block、Approvalなどの生成ファイルを過剰にErrorにしない
- [x] M2-021: メタファイル変更を安全側で検出できる
- [ ] M2-022: すべてのErrorにfixCommandを表示できる
- [ ] M2-023: `scwbs fix` で安全な自動修復だけ実行できる

## M2 テストチェック

- [x] allowedPaths内変更はPassする
- [x] allowedPaths外変更はErrorになる
- [x] forbiddenPaths変更はErrorになる
- [ ] humanGateRequiredPaths変更はApprovalなしでErrorになる
- [ ] managedContractPathsは必要なものだけPassする
- [x] Evidenceコミット後にsubjectHeadCommitがstale扱いされない
- [x] diffHashが同じ差分で安定する
- [x] check失敗時にfinishが失敗する
- [x] fixCommandが出る

## M2 完了条件

- [x] `scwbs finish` だけで checks -> Evidence -> check-diff まで実行できる
- [x] Evidenceのcommit設計が自己参照ループを起こさない
- [ ] AIの範囲外変更を機械的に止められる

---

# M3. Human Gate / Block / Approval Scope

目的:

```text
AIが危険変更を短いコマンドで停止でき、人間承認はPR番号だけでなくcommit/diffに紐づく。
```

対象コマンド:

```bash
scwbs block
scwbs request-approval
scwbs approve
```

## M3 チェックリスト

- [ ] M3-001: `scwbs block "理由"` を実装した
- [ ] M3-002: block reasonをBlock recordに保存できる
- [ ] M3-003: db/auth/permission/security/breaking-api などのstop presetを分類できる
- [ ] M3-004: block時に次に必要な人間判断を表示できる
- [ ] M3-005: block時にAIが実装を継続しない運用文を出せる
- [ ] M3-006: `request-approval` で `requested` recordだけ生成できる
- [ ] M3-007: AI実行モードでは `approve` を拒否できる
- [ ] M3-008: `approve` は人間操作として明示的に実行する設計になっている
- [ ] M3-009: Approvalに `headCommit` を記録できる
- [ ] M3-010: Approvalに `diffHash` を記録できる
- [ ] M3-011: Approvalに `approvedBy` と `approvedAt` を記録できる
- [ ] M3-012: PR番号だけのApprovalを完了承認として扱わない
- [ ] M3-013: 承認後に差分が変わった場合Errorにできる
- [ ] M3-014: 承認scopeが一致する場合のみHuman GateをPassできる
- [ ] M3-015: 承認なしでcompleted化できない
- [ ] M3-016: pre-implementation gate と completion gate を区別できる

## M3 テストチェック

- [ ] `block` の正常系テストがある
- [ ] stop preset分類テストがある
- [ ] AI modeで`approve`できないテストがある
- [ ] Approval scope一致テストがある
- [ ] Approval scope不一致テストがある
- [ ] 承認後追加コミットでErrorになるテストがある

## M3 完了条件

- [ ] AIは危険変更を実装せず停止できる
- [ ] Human approvalは自動生成されない
- [ ] ApprovalはPR番号ではなく、commit/diffに紐づく

---

# M4. WBS Optional / Full Integration

目的:

```text
小規模ではWBSなしで動き、大きくなったらWBSに昇格できる。
```

## M4 チェックリスト

- [ ] M4-001: WBSなし運用用の `contracts/tasks/index.yaml` を定義した
- [ ] M4-002: tasks indexでstatusとdependsOnを管理できる
- [ ] M4-003: WBSが存在しない場合でも `task new` / `start` / `finish` が動く
- [ ] M4-004: WBSが存在する場合は既存WBS仕様を優先する
- [ ] M4-005: tasks indexからWBS候補を生成できる
- [ ] M4-006: WBS変更を直接編集せずchangesetとして生成できる
- [ ] M4-007: `base WBS + changesets = HEAD WBS` を検証できる
- [ ] M4-008: changesetが存在するだけではPassしない
- [ ] M4-009: WBS root completionを既定で拒否できる
- [ ] M4-010: WBSなしからWBSありへの移行手順を文書化した

## M4 テストチェック

- [ ] WBSなし運用のE2Eテストがある
- [ ] WBSあり運用の互換テストがある
- [ ] changeset再現性検証テストがある
- [ ] WBS直編集の検出テストがある

## M4 完了条件

- [ ] CoreはWBSなしでも使える
- [ ] 既存Full SC-WBSプロジェクトでも互換性がある
- [ ] WBS変更はchangesetで再現可能になっている

---

# M5. Review / Spec Change / Full Enhancement

目的:

```text
Coreを重くしないまま、必要なFull機能を段階的に戻す。
```

## M5 チェックリスト

- [ ] M5-001: Review recordの最小データモデルを定義した
- [ ] M5-002: `review request` をCLIで生成できる
- [ ] M5-003: Review結果をcommit/diffに紐づけられる
- [ ] M5-004: Review未完了の場合にcompleted化を止められる
- [ ] M5-005: `block` からSpec Change Proposal draftを生成できる
- [ ] M5-006: Level 1とLevel 2の扱いをCLI上で区別できる
- [ ] M5-007: registryがある場合だけregistry検証を有効にできる
- [ ] M5-008: Lean/Core/Standard/Strictの違いを機械判定できる
- [ ] M5-009: Strict用のRisk RegisterはCoreの必須にしない
- [ ] M5-010: Full機能を有効にしてもTiny Packetが肥大化しない

## M5 テストチェック

- [ ] Review record生成テストがある
- [ ] Review scope不一致テストがある
- [ ] Spec Change Proposal draft生成テストがある
- [ ] profile別validationテストがある
- [ ] Full機能有効時のTiny Packetサイズテストがある

## M5 完了条件

- [ ] Coreの軽さを維持したままFull機能と連携できる
- [ ] Review / Spec Change / Registry が必要なときだけ有効になる

---

# リリース別チェックリスト

## v0.1 Core Packet

- [x] `scwbs task new` が使える
- [ ] `scwbs start` が使える
- [x] `scwbs packet --tiny` が使える
- [x] Tiny Packetが50行以内
- [ ] YAML直書きなしで作業開始できる
- [ ] READMEに最短利用手順がある

## v0.2 Diff Guard

- [x] `scwbs check-diff` が使える
- [x] allowedPaths違反を検出できる
- [x] forbiddenPaths違反を検出できる
- [ ] managedContractPathsを扱える
- [ ] fixCommandが出る
- [ ] CIで利用できるJSON出力がある

## v0.3 Finish Evidence

- [x] `scwbs finish` が使える
- [x] requiredChecksを実行できる
- [x] Evidenceを生成できる
- [ ] `subjectHeadCommit` を記録できる
- [ ] `diffHash` を記録できる
- [ ] PR番号を後から付与できる

## v0.4 Human Gate

- [ ] `scwbs block` が使える
- [ ] `scwbs request-approval` が使える
- [ ] `scwbs approve` が使える
- [ ] Approvalに `headCommit` と `diffHash` が入る
- [ ] 承認後の差分変更を検出できる
- [ ] AIが承認操作をできない

## v0.5 WBS Optional

- [ ] WBSなしで運用できる
- [ ] WBSありでも既存仕様と互換
- [ ] tasks indexからWBS候補を生成できる
- [ ] WBS changeset再現性検証ができる

---

# AIエージェント用 作業前チェック

AIに実装を依頼するときは、対象マイルストーンに加えて次だけを渡す。

```text
作業前に確認すること:
- 対象Task Contractはあるか
- Tiny Packetは生成されているか
- allowedPathsの範囲内か
- forbiddenPathsに触らないか
- DB/API/Auth/Permission/Security変更が必要なら実装せずblockするか
- 完了時はscwbs finishを実行するか
```

## AIがやってよいこと

- [ ] 対象Taskの範囲内の実装
- [ ] 対象Taskの範囲内のテスト追加
- [ ] `scwbs finish` の実行
- [ ] `scwbs block "理由"` による停止
- [ ] 不足コンテキストの明示

## AIがやってはいけないこと

- [ ] YAML/JSONを推測で直書きする
- [ ] allowedPaths外を変更する
- [ ] forbiddenPathsを変更する
- [ ] Human approvalを生成する
- [ ] completed化する
- [ ] WBS全体を再生成する
- [ ] 仕様変更を勝手に実装する

---

# マイルストーン完了レビュー

各マイルストーン完了前に、以下を確認する。

- [ ] 実装済み項目がチェックされている
- [ ] 対応するテストがある
- [ ] CLIヘルプが更新されている
- [ ] READMEまたは該当ドキュメントが更新されている
- [ ] 既存コマンドの後方互換が壊れていない
- [ ] AIに渡す文脈量が増えていない
- [ ] エラー時のfixCommandがある
- [ ] Human approvalを自動生成していない
- [ ] 危険操作は安全側に倒れる

---

# MVP完了チェック

SC-WBS Core 改訂のMVPは、次をすべて満たしたら完了とする。

- [x] YAML直書きなしでTaskを作れる
- [x] Tiny Packetを生成できる
- [x] Tiny PacketがAIに必要最小限の情報だけを渡す
- [x] `finish` でEvidenceを生成できる
- [ ] Evidenceが `subjectHeadCommit` と `diffHash` を持つ
- [x] `check-diff` で範囲外変更を止められる
- [x] `block` で危険変更を停止できる
- [ ] `approve` で承認をdiffHashに紐づけられる
- [ ] 承認後に差分が変わったら再承認が必要になる
- [ ] AI向け文書が短い
- [ ] 既存SC-WBS Full仕様と共存できる
