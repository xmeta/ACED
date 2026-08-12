# scwbs利用者向けquickstart

これはfirst-time consumer向けのclone-free、finish-first pathである。installed `scwbs` CLIを使い、repository contributor setupとは分離する。小さなdocs-only taskなら、最初のgoverned completionまで約10分で到達できる。

## 1. Release tarballをinstallする

対応するconsumer artifactはGitHub Releaseに添付されたself-contained tarballである。WJS validatorを含み、ACED checkoutや`wjs` submoduleを必要としない。

release lifecycle commandはcurrent stable manifestをresolve・verifyするが、npm publicationやunattended upgradeはenableしない。

```bash
SCWBS_VERSION=0.1.0
npm install --save-dev "https://github.com/xmeta/ACED/releases/download/v${SCWBS_VERSION}/scwbs-${SCWBS_VERSION}.tgz"
npx scwbs --version
```

URLを手作業で組み立てずにdiscoveryするにはrelease bootstrap assetをdownloadする。これは`package.json`へexact dependency URLを書き込む前にrelease manifestとtarball digestをverifyする。

```bash
curl --fail --silent --show-error --location \
  https://github.com/xmeta/ACED/releases/latest/download/scwbs-bootstrap.mjs \
  --output /tmp/scwbs-bootstrap.mjs
node /tmp/scwbs-bootstrap.mjs install --save-dev
npm install --ignore-scripts --no-audit --no-fund
```

bootstrapはexact tarball URLを`package.json`へ書く前にreleaseをverifyし、後続の`npm install`がそのpinned dependencyをinstallする。

`node /tmp/scwbs-bootstrap.mjs install --dry-run --json`を使うと、`package.json`を変更せずproposalを確認できる。

installed consumerではread-only version checkを使う。exact package version、release tag、subject commit、tarball digestを報告し、manifest/artifact optionでoffline verificationも可能にする。

```bash
npx scwbs version check --json
npx scwbs version check --manifest ./release-manifest.json --artifact ./scwbs-0.1.0.tgz --json
```

local smoke testでは先にrepositoryをbuild・packし、生成された`.tgz`を空のconsumer projectへinstallする。[`CONTRIBUTING.md`](../../CONTRIBUTING.md)の手順を参照する。

## 2. Initializeしてorientationする

```bash
npx scwbs init --profile lean --agent codex --lang en
npx scwbs doctor
npx scwbs next
npx scwbs next --json
```

`doctor`はlocal installationを診断する。次のstepが不明な場合は`next`をcanonical navigation commandとして使い、IDEまたはautomationでは`--json`を使う。

## 3. Upgradeをproposalする

Upgradeは既定でread-onlyである。consumer pinを変更する前にexact artifact proposalを生成し、migration impactをreviewする。

```bash
npx scwbs upgrade --dry-run --json
npx scwbs upgrade --dry-run --manifest ./next-release-manifest.json --json
```

`--dry-run`なしの`upgrade`はfail-closedでrejectされ、`package.json`、lockfile、Task Contract、generated fileをmutationしない。

## 4. 1つの小さなtaskをcreate、edit、finishする

最小のallowed scopeでTask Contractを作成し、`task new`が表示するexact branch nameを使う。

```bash
npx scwbs task new "Improve a consumer-facing document" \
  --paths "docs/example.md" \
  --stop "source or schema change required"
npx scwbs task start <task-id>
```

変更を行い、inspectしてimplementationをcommitする。standard completion commandは次のとおりである。

```bash
npx scwbs finish --task <task-id>
```

`finish`はTaskのrequired checkを実行し、Evidenceをcollectし、contractに対してdiffをcheckし、registryをverifyする。PR metadata、review、approval、mergeについてはtyped next actionに従う。troubleshooting以外で、このceremonyを長いmanual command chainとして再構成してはならない。

## 5. Human Gateの境界

`finish`がHuman Gate requiredを報告した場合、AIはstopする。人間がcurrent diffとEvidenceをreviewし、CLIが示すexact approval commandを実行する。Lean taskではexact TTY confirmationを`--reason`へcopyする場合がある。

```bash
npx scwbs approval approve \
  --task <task-id> \
  --actor human \
  --reason "<exact confirmation printed by scwbs>"
```

confirmationはcurrent Evidence subject headとdiff hash（`CONFIRM TTY APPROVAL <task-id> <subjectHeadCommit> <diffHash>`）にbindされる。Evidenceまたはdiffが変わった後にold commandを再利用せず、current scope向けに`scwbs`が表示するcommandを再実行する。

AIは`--actor human`を代用せず、自分のworkをapproveせず、gate回避のためTask Contractを広げてはならない。

## 6. Contributorと高度な経路

このquickstartはinstalled consumer向けである。ACED repositoryのcontributorは[`CONTRIBUTING.md`](../../CONTRIBUTING.md)を使い、必要に応じて[`getting-started.md`](getting-started.md)のadvanced repository flowを読む。そのflowはmanual check、Evidence/registry repair、`check-diff`、review、troubleshooting detailを意図的に保持するが、first-use happy pathではない。
