# main merge protectionとenforcement boundary

このlegacy referenceは日本語でmaintainし、command nameとschema fieldは変更しない。

## 現在のrepository状態

2026-08-31時点のGitHub API観測では、このrepositoryはpublic、repository rulesetsは
0件、`main` branch protection APIは404 `Branch not protected` である。このsnapshotは
現在のvisibilityや保護状態を保証しないため、作業前に
`gh repo view xmeta/ACED --json visibility`、`gh api repos/xmeta/ACED/rulesets`、
`gh api repos/xmeta/ACED/branches/main/protection` を再確認する。

```text
Branch not protected
```

repository設定ではmerge commit、squash merge、rebase mergeの3方式が有効である。
したがってGitHub側のrequired status check、direct push禁止、force push禁止、
administrator bypass禁止は確認も強制もできない。

この状態で「GitHubがmainを保護している」と表現してはいけない。現行の強制
レベルはrepository-local commandによる通常経路のfail-closed検査である。

## 通常の保護経路

PRの状態だけを検証する。

```bash
npm run scwbs -- merge --pr <number> --preflight-only
npm run scwbs -- merge --pr <number> --preflight-only --json
```

検証後にmergeする。

```bash
npm run scwbs -- merge --pr <number>
```

commandは次をすべて要求する。

- PR番号が取得結果と一致する
- 対象repositoryがcurrent checkoutのGitHub `origin`と一致する
- PRがopenかつnon-draft
- base branchが`main`
- headが40桁のcommit SHA
- merge stateが`CLEAN`
- `scwbs` workflow由来のaggregate `validate` checkがちょうど1件
- `validate` statusが`COMPLETED`かつconclusionが`SUCCESS`
- `validate` details URLが同じrepositoryのGitHub Actions runを指す

条件を満たした場合だけ、次と同等のsquash mergeを実行する。

```bash
gh pr merge <number> --squash --delete-branch \
  --match-head-commit <verified-head-sha>
```

`--match-head-commit` によりpreflight後のhead差替えはmergeを失敗させる。
commandは`--admin`、`--auto`、merge commit、rebaseを公開しない。
`finish`もchecks成功後のnext actionとしてこのcommandを案内する。

## Phase A: 信頼済みワークフロー整合性receipt

Issue #595 のPhase Aでは、`scwbs` のpull request runがsuccessで完了した後だけ、
default branch上の `scwbs-workflow-integrity` workflowが動く。このworkflowはPR
headをcheckoutまたは実行せず、contents/actions/pull-requestsのreadと、current PR headへ
receiptを記録するためのchecks writeだけで、triggering run、repository、関連PR、base/head
SHA、changed-filesを再検証する。
APIのpagination結果、件数、PR head/baseの再読込が一致しない場合、または256 files
を超える場合はreceiptを生成しない。

同じhead SHAに対するverifier runはconcurrency groupで直列化し、cancelしない。最初の
stepはreceipt fileだけを生成し、artifact uploadがsuccessになった後の別stepがreceiptを
再読込してPRのopen/main/base repository/base SHA/head SHAを再確認してからcustom checkを
create/updateする。この順序によりartifact upload失敗時にsuccess checkを残さない。

receiptはtrusted verifier runのartifactとして保存し、`scwbs.workflow-integrity.v1`
のtype、repository、PR、base/head、triggering run、base側
`.github/workflows/scwbs.yml` とverifier definition自身のSHA-256、versioned
control-surface manifestとdigest、control files、verifier runを含む。control filesは
filename、status、role、counterpart、head/previous blob SHAをpattern順にdeterministicに
正規化し、その観測値digestも含む。added/modified/current renameはhead blob SHAを持つ。
renameのprevious側はhead treeに存在しないため両blob SHAをnullとし、removedは
`role: previous`、`headBlobSha: null`、`previousBlobSha: file.sha` として記録する。
control surfaceはworkflow/local action、CI runner、
package/config、merge enforcement implementationを明示的に分類する。同じreceiptはcurrent
PR headの `workflow-integrity` custom checkへ一意にupsertする。設定上のdetails URLはtrusted
verifier run URLだが、GitHub APIが返す同一repositoryの実check IDによるcanonical
`https://github.com/{repository}/runs/{check.id}` もPhase Bで許可する。信頼元runはartifact
receiptとrun APIで独立検証する。artifactはPhase Bの独立した再取得候補でもある。forkの
`workflow_run.pull_requests` payloadにはPR情報がない場合があるため、verifierはpayloadを
信頼せずCommits APIの `listPullRequestsAssociatedWithCommit` を読み、ちょうど1件であることを
要求する。custom checkの
作成自体がGitHub APIで拒否される場合はsuccessを生成せずworkflowをfailureにする。
main反映後も、same-repository PRとfork PRの双方でcustom checkの作成、artifact取得、
Phase B API verificationを実際にsmokeするまではfork supportを完了扱いにしない。

このPhase A receiptはHuman Approval、Review、`validate`、merge enforcementを代替しない。
bootstrap PR自身には新しいdefault-branch verifierを遡及適用できない。main反映後の
Phase Bで、`scwbs merge --preflight-only` がGitHub APIからtrusted verifier runと
artifactを取得し、current repository/PR/base/head/run/path/digestを検証して初めて
workflow-control PRをmerge-readyにできる。Phase Bはcurrent Evidence/Approvalの
headCommitとdiffHashも検証し、Human Gateをreceiptで置換してはならない。

## フェーズB: merge preflightによる強制

`merge --preflight-only` は現在のPR filesをGitHub APIからboundedに再取得し、workflow、
local action、CI runner、package/config、merge enforcementのcontrol surfaceを再分類する。
source-only PRは従来どおりaggregate `validate` のexact-head successだけを要求する。control
surfaceがあるPRでは、current headの `workflow-integrity` check、receipt、trusted base
workflow digest、verifier definition digest、verifier run、triggering `scwbs` runを現在の
GitHub API stateへ再検証する。check-runsとartifactsは各ページの`total_count`、filesはPRの
`changed_files`と再照合し、重複、上限超過、再読込中のPR変更を拒否する。receiptはcheck
summaryをbounded locatorとしてのみ使い、trusted verifier runのexpected name artifactを
一意に取得する。artifact IDのraw ZIPを再取得し、API digestと照合したうえで、メモリ上で
単一の通常ファイル`workflow-integrity-receipt.json`（32 KiB以下）を厳密に展開・検証する。
展開したbytesを正本とし、summary bytesとの完全一致、run所属、期限、symlink/extra fileを
検証する。missing、pending、複数、digest/PR/base/head/run不一致、API failureは
fail-closedである。

control surface PRは、current PR番号を記録したTask Evidenceを一意に解決でき、Evidenceの
subject head `S` がPR final head `H` のancestorで、`S..H` の差分が当該TaskのEvidence、
payload、Approval、Review、registryだけであり、Evidence diffHashをbase merge-baseから
再計算して一致し、Human Approval scopeが一致する場合だけmerge-readyになる。Task契約の
`humanGateRequiredPaths` が空でもcontrol surface全体を強制gateとして評価する。local
Task/Evidence/ApprovalはPR headのcommitted metadataと一致するものだけを読む。JSON reportの
`workflowTrust`は`not-required`、`verified`、`blocked`とcontrol files、trusted base、
verifier run、next actionを返す。Phase B PRではmain由来verifierのcheck/artifactをlive smokeし、
main反映後の次control PRでenforcementを確認する。

## fail-closedとなるケース

次の場合はmerge subprocessを起動しない。

- GitHub CLIが利用不能、未認証、または不正JSONを返す
- PRがclosed、merged、draft、main以外、またはmerge state不明
- `validate`がmissingまたは複数存在する
- `validate`がpending、failure、cancelled、timed out、skipped、neutral
- `validate`が`scwbs`以外のworkflowから来ている

integration testはfake `gh` fixtureを使い、これらの拒否時に
`gh pr merge` が呼ばれないことを検証する。意図的なfailing PRは作らない。

## 強制と監査の境界

| Path                             | Current enforcement                                        | Audit evidence                                                |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `npm run scwbs -- merge`         | aggregate `validate`とhead SHAへfail closed                | versioned preflight report、GitHub PR `mergedBy`、Actions run |
| direct `gh pr merge` / API merge | repository-localには強制なし                               | GitHub PR timeline。迂回防止ではない                          |
| direct push / force push         | GitHub plan上の保護を確認・強制できない                    | GitHub commit/event履歴。拒否保証ではない                     |
| `--admin` / ruleset bypass       | SC-WBS commandは提供しないがprivileged actorを阻止できない | 利用可能なGitHub audit/event記録                              |

この境界では完全なmain保護を保証しない。AIと人間は通常経路としてSC-WBS
merge commandを使い、迂回を許可してはならない。

## Human Decision

次のいずれかはrepository ownerが明示決定する。AIは実行しない。

1. GitHub Pro/Team等へ変更し、`main` rulesetで`validate`をrequiredにする
2. 現在のpublic visibilityを維持したまま、`main` ruleset/branch protectionを設定する
3. merge権限を専用bot/Appへ限定し、server-sideで同じpreflightを実施する
4. branch protection未設定を継続し、本書のlocal enforcementと保証限界を受容する

どの選択でも、direct/force push、administrator/bypass、required
`validate`、audit retentionを明示的に再評価し、決定理由を記録する。
