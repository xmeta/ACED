# scwbs CLIリファレンス

このfileはACEDにbundledされた`scwbs` CLI（package name `scwbs`）のdetailed command indexである。command exampleが増えた場合も`README.md`は短く保ち、ここへlinkする。

npm script経由で実行する。

```bash
npm run scwbs -- --help
```

> **表記規約（Conventions）**
>
> - 説明文は日本語、コマンド名・オプション名・フィールド名・コード例は英語のまま記載する。
> - Task IDの例は本ドキュメント全体で `SCWBS-*` 形式に統一する（理由は「Task IDとブランチ命名」を参照）。従来この文書には `WBS-001-004` のような例が混在していたが、これは実装が生成する正規のID形式ではない。
> - コマンドが**変更するもの**（tracked files / git common dir / network）は「Mutation / Read-only 一覧」で分類する。
> - 終了コードは「終了コード」の節にある実装済みの値だけを記載する。文書化されていない終了コードは存在しないものとして扱う。

## ReviewとApproval

```bash
npm run scwbs -- review-queue
npm run scwbs -- review-queue --limit 10
npm run scwbs -- review-queue --json
npm run scwbs -- review-queue --verbose
npm run scwbs -- review route --task SCWBS-001
npm run scwbs -- review request --task SCWBS-001 --pull-request "#42"
npm run scwbs -- approval request --task SCWBS-001 --pull-request "#42" --note "Awaiting human review"
npm run scwbs -- approval request --task SCWBS-001 --pull-request "#42" --note "Awaiting human review" --json
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor human --reason "<exact TTY confirmation printed by scwbs>"
SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
npm run scwbs -- completion apply --tasks SCWBS-001 --task SCWBS-999 --reason "Reviewed and accepted"
npm run scwbs -- completion apply --tasks SCWBS-001 --task SCWBS-999 --reason "Reviewed and accepted" --apply
```

### Risk Register v1

Risk artifactは `contracts/risks/*.yaml` に保存され、`schemaVersion: scwbs.risk.v1` を要求する。likelihood/impact はそれぞれ1〜5、scoreは固定の積で、1–4がLow、5–9がMedium、10–16がHigh、17–25がCriticalである。scoreやlevelを手入力して基準を弱めることはできない。

```bash
npm run scwbs -- risk list --json
npm run scwbs -- risk show RISK-EXAMPLE --json
npm run scwbs -- risk add --id RISK-EXAMPLE --title "Example risk" --likelihood 3 --impact 4 --owner team --actions "Add control" --tasks TASK-001 --json
npm run scwbs -- risk update RISK-EXAMPLE --actions "Verify control" --json
npm run scwbs -- risk accept RISK-EXAMPLE --actor human --reason "CONFIRM TTY RISK RISK-EXAMPLE <subjectHeadCommit> <diffHash>" --json
```

`risk list/show/add/update` のJSONはboundedで、add/updateは `--dry-run` でartifactを書かずに結果を確認できる。`risk accept` はHuman-onlyで、リンクされたEvidenceの現在のsubjectHeadCommitとdiffHashを含むexact TTY confirmationが必要である。Strict profileの `scwbs check --json` は、リンクされた未closedのHigh/Critical riskについて、treatment actionの欠落、Human acceptanceの欠落、またはEvidence変更後のstale acceptanceをmachine-readable errorとして返す。Lean/StandardではこのRisk Register gateを追加しない。

### Core alias: `request-approval` / `approve`

`approval request` と `approval approve` には、top-levelのCore alias `request-approval` と `approve` がある。artifactを作る内部関数は共通だが、option parsingは完全には同一でない。top-level aliasはどちらも `--pr` と `--pull-request` を受け付け、`approval request` / `approval approve` は `--pull-request` だけを受け付ける。複数語のnote/reasonは、どちらの形式でも引用符または `--note=...` / `--reason=...` を使う。

```bash
npm run scwbs -- request-approval --task SCWBS-001 --pull-request "#42" --note "Awaiting human review"
npm run scwbs -- approve --task SCWBS-001 --pr 42 --actor human --reason "<exact TTY confirmation printed by scwbs>"
```

`review-queue` の既定出力は候補数に比例せず、review health集計、主要blocker集計、ready優先の上位候補、omitted件数、次のコマンドを表示する。候補の既定上限は5件で、`--limit <count>` で正の整数へ変更できる。従来の全候補・全理由・警告・blocker sectionが必要な場合は `--verbose`、機械処理には `--json` を使う。`--json` は明示した `--limit` がなければ全候補を返し、指定時は `candidates` と `omitted` に分ける。JSONの正式なshapeは [`schemas/review-queue-summary.schema.json`](schemas/review-queue-summary.schema.json) で定義する。`--json` と `--verbose` は同時指定できない。

`review route`はEvidence changed fileからrequested reviewer roleをpreviewする。`review request`はそのroleを`contracts/reviews/<task-id>.yaml`の`requestedReviewers`へ記録し、同じsuccessful operationでderived `contracts/registry.yaml`をsynchronizeする。written artifactとnext actionを得るには`--json`を使う。

### 独立Reviewのライフサイクル（`review approve` / `review changes-requested` / `review close`）

`approval approve`（Human Gate承認）とは別に、`review` サブコマンド配下には独立レビュー判定を記録するコマンド群がある。これらは「Human Gateの承認」ではなく「レビューでの合否判定」を記録するためのもので、`evidence-human-gate-review.md` の Review Profile（Self Review / Independent AI Review / Human Review）の判定結果をCLI上に残す。

```bash
npm run scwbs -- review approve --task SCWBS-001 --actor human --findings "LGTM, matches acceptance criteria"
npm run scwbs -- review changes-requested --task SCWBS-001 --actor human --findings "Missing error handling for empty input"
npm run scwbs -- review close --task SCWBS-001 --actor human
```

- `review approve --task <id> --actor human --findings <text> --force` — レビューを承認済みとして記録する。
- `review changes-requested --task <id> --actor human --findings <text> --force` — 変更要求としてレビューを記録する。
- `review close --task <id> --actor human --force` — レビューを完了状態にする（`--findings` は取らない）。

3コマンドはいずれもactorが `human` でなければ失敗する。`--actor` を省略した場合は `SCWBS_AGENT_MODE` がfallbackになり、値が `ai` なら拒否される。ただし、これはactor文字列の検査であり本人性を独立検証する仕組みではない。ガードレール上、AI agentは `--actor human` を自己申告して実行してはならない。AIはfindingsを人間へ報告し、人間が内容を確認してreview transitionを記録する。

Approval recordは`contracts/approvals/*.yaml`配下にあり、Evidenceとは独立してhuman-review metadataを持てる。

```yaml
id: APR-SCWBS-006
type: approval
taskId: SCWBS-006
status: requested
pullRequest: "#42"
notes:
  - Awaiting human gate review
```

`approval request`はhuman approvalをfabricateせず`requested` recordを作る。`approval approve`はreview済みtaskをapproved recordへ変えるexplicit human actionで、`status: approved`、`approvedBy: human`、`approvedAt`を書き込む。`--note`と`--reason`はquoted multi-word argumentと`--note=Awaiting human review`、`--reason=Evidence reviewed`のようなinline syntaxの両方で使える。

`approval request --json`は`approvalId`、`taskId`、`status: requested`、`requestedAt`、bounded `notes`、`nextActionOwner: human`、`nextAction`を持つboundedな`scwbs.approval-request.v1` documentを1件出力する。schemaは[`schemas/approval-request.schema.json`](schemas/approval-request.schema.json)である。JSON outputはresponse projectionだけで、requestをapproveせず、approval provenanceを公開せず、既存YAML artifactとpolicy checkを変更しない。`--json`なしではexisting YAML outputを維持する。

`approval request [note...]` はlegacy noteを正式な可変位置引数として表示・受理する。`status`、`health`、`finish`など引数を宣言しないcommandへ余分な位置引数を渡すとusage errorになる。

### Human GateとDelegated Approvalの違い

`--actor delegated-ai` は、Task Contractの `approvalPolicy.mode: delegated` で明示的に委譲されたTaskだけに使える。`--scope human-gate|post-finish` は必須で、policyの `scopes`、UTC `expiresAt`、`tokenSha256` と32 bytes以上の環境変数 `SCWBS_APPROVAL_DELEGATION_TOKEN` を検証する。policy未指定、`human-only`、token欠落・不一致、弱いtoken、期限切れ、scope不一致はすべてfail-closedになる。tokenは出力・永続化せず、成功時は `approvalMode: delegated`、`delegationSource`、`delegatedBy`、`executedBy: ai-agent`、`delegationScope`、`delegationProof` を記録してHuman Approvalと**明確に区別する**。consumerもHMAC proofを再検証し、Human Gateでは`human-gate`、completionでは`post-finish`だけを受理する。

重要な点として、`--scope human-gate` を満たしたApproval記録は `approvalMode: delegated`（`approvedBy: human` ではない）のまま保存される。`--scope human-gate` という名前は「この委譲承認が、ワークフロー上Human Gateが要求される地点を満たす」という意味であり、「人間が今この瞬間にレビューした」ことを意味しない。監査・レビューを行う人は、次の2つのフィールドを必ず区別して確認すること。

| フィールド                 | `approvedBy: human` の場合       | `approvalMode: delegated` の場合                                                                                              |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 承認の実体                 | 人間がその場でレビューし承認した | 事前にcreation commitで固定されたpolicyに基づき、AI agentが条件を満たして承認記録を作成した                                   |
| `delegator`/`source`の検証 | 該当なし                         | _declared_ provenanceであり、実在本人性やtoken注入者を独立に検証するものではない（下記「`approval delegation prepare`」参照） |
| 監査上の扱い               | 直接的な人間の意思決定の記録     | 「委譲policyの条件が満たされた」ことの記録。policy自体を人間が事前承認した根拠と併せて確認する必要がある                      |

`human-gate` という scope 名を「人間限定」の意味だと誤読しないよう、この違いを社内ドキュメントやレビュー手順に明記することを推奨する。

### `approval delegation prepare`

新規Taskのcontract-only creation commitより前に、外部secret transportに設定済みのtokenからsecret-freeなpolicy patchとhandoffを生成する。tokenはCLI引数に渡さない。

```bash
SCWBS_APPROVAL_DELEGATION_TOKEN="<external-secret>" npm run scwbs -- approval delegation prepare \
  --task SCWBS-001 \
  --scopes human-gate,post-finish \
  --expires-at 2026-12-31T00:00:00.000Z \
  --source https://example.invalid/policy/42 \
  --reason "Unattended evidence workflow" \
  --delegated-by release-owner
```

出力の `policyPatch` は未commitのTask Contractへ人間が適用し、`task lock` 後にcontract-only creation commitへ固定する。既存・commit済みTaskのpolicy追加やscope拡張には使えない。handoffはhuman-gateとpost-finishのconsumer commandを別々に示し、token値は含まない。shell、CI secret store、任意の`.env` loaderはtransportの選択肢だが、SC-WBS CLIは`.env`を自動読込しない。

CLIは `.env` を自動読込しない。必要ならshell側で `.env` を読み込むかCI secretから環境変数を注入するが、`.env` はauthority sourceではなくsecret transportにすぎない。Task Contractの委譲policyはcreation commitでauthority baselineへ固定され、後からの追加・拡張・hash変更は拒否される。記録されるdelegator/sourceはdeclared provenanceであり、実在本人性やtoken注入者を独立に検証するものではない。

#### Windows環境でのtoken指定

上記の `SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" npm run scwbs -- ...` の書き方はPOSIX shell専用である。Windowsでは次のいずれかを使う。

PowerShell:

```powershell
$env:SCWBS_APPROVAL_DELEGATION_TOKEN = "<secret>"
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
Remove-Item Env:SCWBS_APPROVAL_DELEGATION_TOKEN
```

cmd.exe:

```cmd
set SCWBS_APPROVAL_DELEGATION_TOKEN=<secret>
npm run scwbs -- approval approve --task SCWBS-001 --pull-request "#42" --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
set SCWBS_APPROVAL_DELEGATION_TOKEN=
```

どのシェルでも、token値はshell historyに残り得る。可能な限りCI secret store経由で環境変数を注入し、対話シェルへ直接入力しないことを推奨する。

`finish`がHuman Approvalを要求する場合、text outputとJSON `nextAction`はcurrently implementedな`approval approve` optionだけを使う。特に未対応の`--approved-by`や`--human-confirm` optionは出力しない。

PRが存在した後は`--pull-request`付きでEvidenceをrefreshし、review/completion queueがworkをreview済みPRへ結び付けられるようにする。`evidence collect --force`でexisting Evidenceをrefreshしreplacement PRを指定しない場合、existing `git.pullRequest` valueをdropせずpreserveする。

`evidence collect` の既定成功出力は、Evidence YAML全文ではなく `path`、check集計、変更ファイル数、PRを含む固定5行のサマリである。機械処理にはversioned summaryを返す `--json`、サマリと全YAMLの確認には `--verbose`、YAMLだけをstdoutへpipeする場合は `--output -` を使う。これら3つの出力modeは同時指定できず、`--output` の対象は `-` のみである。JSONの正式なshapeは [`schemas/evidence-collect-summary.schema.json`](schemas/evidence-collect-summary.schema.json) で定義する。`finish` は内部のEvidence収集をquietに実行するが、failed check、Human Gate、次アクションなど `finish` 自身の重要な結果は省略しない。

`evidence collect` と `finish` はEvidence YAMLに加えて
`contracts/evidence-payloads/<task-id>.patch` を生成する。payloadは
`git-diff-binary-v1` のtracked retention artifactであり、Evidence管理fileと
payload自身を除外するため、metadata-only descendantや再収集でhashが循環しない。
`finish` はpayload、Evidence、Registryを同じrollback unitでcheckpointする。

既存Evidenceの限定backfillには
`evidence retain --task <id> [--fetch-pr-head]` を使う。recorded subject、
base、diffHash、changedFilesが再現できない場合は書き込まない。
`--fetch-pr-head` はrecorded PRのhead refだけを取得し、subject ancestryを検証する。

`evidence prune [--json]` はtracked patch-artifactの件数、サイズ、retention mode、
archived Task候補を表示するread-only inventoryである。候補はretention cutoffを
自動選択せず、`--apply` は常にfail closedする。保持期限、外部archiveの耐久性、
payload削除後の監査trust、Git履歴の書換えはHuman Decisionと新しいTask Contractが必要である。

`evidence annotate` は既存Evidenceの `git.pullRequest` と手動の `testQuality` だけを更新し、`commit`、`subjectHeadCommit`、`diffHash`、`changedFiles`、`checks`、`testQualityObservation` を保持する。merge後のbranchやmetadata-only branchで元の実装Evidenceへ注記する場合は再収集ではなくこのコマンドを使う。既存のbranch-diff Evidenceが実装ファイルを記録しているのに、Task branch外の空差分から `evidence collect` しようとした場合、CLIはprovenance上書きを拒否する。

`finish` はrequired checks実行前にcontract lockとtestQuality metadataをpreflightし、check結果をまずcandidate Evidenceとしてmemory上に構築する。failed checkまたはHuman Gate以外のcheck-diff違反ではcandidateを破棄するため、既存payload、Evidence、Registryを上書きしない。検証済みcandidateはpayload、Evidence、Registryを同じrollback unitとして置換し、Human Gate待ちはこの整合checkpointを保存して `awaiting-human-approval` を返す。checkpoint途中の書き込み失敗は全fileを開始前の内容へ戻す。

完了時のnext actionはEvidenceとReviewのPR metadataを正規化して決定する。両方のPR番号が不一致なら修正command付きで停止し、PR番号がなければ新規PR作成、既存PRがあればdraft、checks pending、checks failure、checks success、未mergeのclosed、mergedの状態に応じてready化、checks監視、failure確認、merge、reopen、main同期を案内する。未mergeのclosed PRでは過去のchecks結果にかかわらずmergeやchecks watchへ進まず、`gh pr reopen <number>`を案内するため、必要に応じてEvidence / ReviewのPR metadataを確認してから再開する。`gh pr view`が未導入・未認証などで状態を取得できない場合も、新規PR作成へ戻らず、repository-local metadataの既存PR番号を使ったchecks確認へ安全にdegradeする。plain出力とJSONの `nextAction` / `resumeCommand` は同じcommandを返す。

tracked artifactを変更せずに開始条件だけを確認する場合は `npm run scwbs -- finish --task <task-id> --preflight` を使う。これはrequired checksも実行しないが、診断履歴としてgit common dirへfinish lifecycle receiptを記録する。`finish --json` は全終了経路で `phase`、`outcome`、実際に変更した `mutatedFiles`、再開用の `resumeCommand` を返す。Evidence provenance、Human Approval、既存Review scopeのwarningが残る場合はmerge-readyを表示せず、`fixCommand`を返す。PR metadataの欠落自体は新規PR作成のnext actionとなり、EvidenceとReviewのPR番号不一致はactionable errorとして停止する。repository全体のlegacy warningはこの判定へ含めない。正式なJSON shapeは [`schemas/finish-summary.schema.json`](schemas/finish-summary.schema.json) で定義する。

### `completion apply` の `--tasks` と `--task`

この2つのoptionは名前が非常に紛らわしいため、明示的に説明する。

| Option          | 意味                                                                                      | 例                            |
| --------------- | ----------------------------------------------------------------------------------------- | ----------------------------- |
| `--tasks <ids>` | 完了として承認・適用する**既存の実装Task**のID（カンマ区切りで複数可）                    | `--tasks SCWBS-001,SCWBS-002` |
| `--task <id>`   | この completion 操作自体を所有する **completion Task**（changesetをコミットするTask）のID | `--task SCWBS-999`            |

```bash
npm run scwbs -- completion apply \
  --tasks SCWBS-001,SCWBS-002 \
  --task SCWBS-999 \
  --reason "Reviewed and accepted"
```

`completion apply`はhand-written YAMLなしでreview済みWBS nodeをcompleteする。既定はdry-runで、書き込む予定のapprovalと`changeNodeStatus` operationを表示する。`--apply`ではexisting approved recordをvalidateし、`contracts/changesets/<completion-task-id>-complete-reviewed-work.json`を書き、WBS changesetをapplyし、registryをrebuildする。既定ではroot-node completionを拒否し、`--allow-root`はexplicit human decision後だけ使う。

> **将来的な改善案**：`--tasks`/`--task` という命名は初見では区別しづらい。CLIの後方互換性を保つ必要がなければ、`--completed-tasks <ids>` と `--completion-task <id>` のような自己説明的な名前への変更を検討する価値がある（現行実装のoption名は変更していない）。
