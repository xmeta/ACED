# main merge protectionとenforcement boundary

このlegacy referenceは日本語でmaintainし、command nameとschema fieldは変更しない。

## 現在のrepository状態

2026-08-09時点のGitHub API観測では、このrepositoryはpublicである、という
historical snapshotを記録している。この記録は現在のvisibilityや保護状態を
保証しないため、作業前に `gh repo view xmeta/ACED --json visibility` と
`gh api repos/xmeta/ACED/branches/main/protection` を再確認する。
`main` branch protectionとrepository rulesetsの読取は、どちらも次の403を返す。

```text
Upgrade to GitHub Pro or make this repository public to enable this feature.
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

| Path | Current enforcement | Audit evidence |
|---|---|---|
| `npm run scwbs -- merge` | aggregate `validate`とhead SHAへfail closed | versioned preflight report、GitHub PR `mergedBy`、Actions run |
| direct `gh pr merge` / API merge | repository-localには強制なし | GitHub PR timeline。迂回防止ではない |
| direct push / force push | GitHub plan上の保護を確認・強制できない | GitHub commit/event履歴。拒否保証ではない |
| `--admin` / ruleset bypass | SC-WBS commandは提供しないがprivileged actorを阻止できない | 利用可能なGitHub audit/event記録 |

この境界では完全なmain保護を保証しない。AIと人間は通常経路としてSC-WBS
merge commandを使い、迂回を許可してはならない。

## Human Decision

次のいずれかはrepository ownerが明示決定する。AIは実行しない。

1. GitHub Pro/Team等へ変更し、`main` rulesetで`validate`をrequiredにする
2. 情報公開が許容される場合だけrepositoryをpublic化して保護を有効にする
3. merge権限を専用bot/Appへ限定し、server-sideで同じpreflightを実施する
4. privateの現状を維持し、本書のlocal enforcementと保証限界を受容する

どの選択でも、direct/force push、administrator/bypass、required
`validate`、audit retentionを明示的に再評価し、決定理由を記録する。
