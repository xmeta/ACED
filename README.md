# scwbs

この README はリポジトリの概要、導入手順、標準的な作業入口を日本語で案内する。

`scwbs` は **SC-WBS Development** を運用するための TypeScript CLI である。

> AIと協調してSpec ContractとWBSを用いる開発手法

このツールは、AI支援作業を明示的なTask Contractの範囲内に保つ。Evidenceを記録し、変更ファイルを契約と照合し、AIが推測して進めるのではなく、危険な変更をHuman Gateへ戻す。

## License

別途記載がない限り、`scwbs`のソースコードとrepository-authored documentationはGNU General Public License version 3.0 onlyでライセンスされる。全文は[LICENSE](LICENSE)を参照する。`wjs` submoduleは別依存であり、独自のライセンス条件を維持する。

## Start Here

| 読者 | 最初に読む文書 |
|---|---|
| 初めて使う人間 | `docs/scwbs/quickstart.md` |
| 人間のcontributor | `CONTRIBUTING.md` |
| Security reporter | [SECURITY.md](SECURITY.md) |
| Release history | [CHANGELOG.md](CHANGELOG.md) |
| Docs navigator | `docs/README.md` |
| AI implementation agent | `AGENTS.md`、次に `contracts/tasks/<task-id>.yaml` |
| AI reviewer | `docs/scwbs/ai-agent-guide.md` |
| CLI/reference user | `docs/scwbs/cli-reference.md` |
| SC-WBS Core designer | `docs/sc-wbs-core/00-index.md` |

`docs/`配下の全ファイルを最初から読んではならない。意図したworkflowは、まず小さいcontextを読み、必要な場合だけ詳細文書へ進むことである。

## 1. このtoolについて

`scwbs`はAI支援作業のためのguardrail CLIである。各変更に明示的なTask Contractを与え、変更ファイルを契約と照合し、Evidenceを記録し、危険な作業をHuman Gateへ戻す。

## 2. Consumer Installation

初回利用では[consumer quickstart](docs/scwbs/quickstart.md)に従う。これはinstalled CLIを使う、clone-freeかつfinish-firstのcanonical pathである。local distribution smoke testでは、CLIをbuildしてpackし、空のconsumer projectへtarballをinstallする。

```bash
corepack npm run build
npm pack
mkdir /tmp/scwbs-consumer
cd /tmp/scwbs-consumer
npm init -y
npm install --save-dev /path/to/scwbs-0.1.0.tgz
npx scwbs --version
```

packed artifactにはWJS validator、apply runtime、schemaが含まれるため、consumerはACED checkoutや`wjs` submoduleを必要としない。対応するrelease pathはGitHub Releaseへ添付するself-contained tarballであり、このrepositoryはnpmへpublishしない。

## 3. Minimal Setup

このrepositoryはNode.js `>=22.12.0`とnpm `>=10`をサポートする。`packageManager`でnpm `10.9.0`をpinしているため、install前にCorepackをenableし、対応するnpm releaseでlockfileを生成する。CIはminimum supported Node.js versionとcurrent LTS versionの両方を検証する。

required WJS schemaは`wjs` Git submoduleに保持する。通常のclone後は、dependenciesをinstallする前にsubmoduleをinitializeする。

```bash
git submodule update --init --recursive wjs
```

dependenciesをinstallする。

```bash
corepack enable
corepack npm install
```

local installationを確認する。

```bash
npm run scwbs -- doctor
npm run scwbs -- check
npm run scwbs -- docs check
```

## 4. DoctorとCheck

setup diagnosticsには`doctor`を、contract/registry healthには`check`を使う。

```bash
npm run scwbs -- doctor
npm run scwbs -- doctor --fix
npm run scwbs -- check
npm run scwbs -- status
npm run scwbs -- status --strict
npm run scwbs -- registry rebuild --check
```

`doctor`は、宣言されていればconsumer packageから、standalone consumerではinstalled scwbs packageからNode.js requirementを読み取る。そのrange、npm、root `node_modules`、`wjs/node_modules`（またはbundled runtime）、`git`、`contracts/registry.yaml`、`contracts/wbs/project.wbs.json`、WJS schema、およびcheck/health issueについてPASS/FAILを報告する。各FAILにはsuggested fix commandを表示する。

`doctor --fix`はsafe repair（例: `npm install`）だけを実行する。destructive operationは拒否し、危険な操作は表示されたsuggested fix commandに従う。

setupが不完全かもしれない場合は`check`の前に`doctor`を実行し、opaque errorではなくfailureを明示的に診断する。

`docs check`は`docs/document-lifecycle.json`を検証し、document-set status、entrypoint、normative ownership、successor link、current CLI versionとのcompatibilityを確認する。`--json` outputはCI toolingで利用でき、同じerrorはaggregate `scwbs check`にも含まれる。

`status`はWBS lifecycle countとcompletion trustを分離する。completedまたはarchived Taskが`verified`になるのは、required checks、Evidence subject、およびHuman Approval scopeを検証可能な場合だけである。`--strict`はterminal Taskのtrustが低下、検証不能、または未評価の場合にnon-zero statusを返す。

## 5. AI Minimum Flow

AI agentはactive Task Contractから開始し、広範なdocs scanを避ける。既定ではtiny packetを使う（`--tiny`がdefaultである）。

```bash
npm run scwbs -- packet --task <task-id>
```

より多くのcontextが必要な場合だけ`--standard`または`--full`を使う。

```bash
npm run scwbs -- packet --task <task-id> --standard
npm run scwbs -- packet --task <task-id> --full
```

required checks、Evidence、diff validation、registry checkは1つのcommandでfinishする。

```bash
npm run scwbs -- finish --task <task-id>
```

`finish`はrequired checks、Evidence collection、diff guard、registry consistency checkを自動実行する。またHuman Gate pathを検出し、人間のreviewer向けにnext actionを表示する。

stop conditionに達した場合は推測せずblockする。

```bash
npm run scwbs -- block "Human Gate required" --task <task-id>
```

## 5. Human Reviewer Flow

人間はapproveする前にPR、Evidence、current diffをreviewする。AI agentは人間に代わってapproval commandを実行してはならない。

```bash
npm run scwbs -- review-queue
npm run scwbs -- approve --task <task-id> --pr <number> --actor human --reason "<exact TTY confirmation printed by scwbs>"
```

詳細commandも利用できる。

```bash
npm run scwbs -- approval approve --task <task-id> --pull-request "#<number>" --actor human --reason "<exact TTY confirmation printed by scwbs>"
```

`finish`はHuman Gateのnext actionにこのimplemented command shapeを使う。未対応の`--approved-by`や`--human-confirm` optionは出力しない。

approvalとCI成功の後は、fail-closedなSC-WBS pathでmergeする。

```bash
npm run scwbs -- merge --pr <number> --preflight-only --json
npm run scwbs -- merge --pr <number>
```

commandは、`main`をtargetとするopenかつnon-draftのPR、`CLEAN` merge state、current checkoutのGitHub `origin`、および`scwbs` workflow/repositoryからの成功したaggregate `validate` checkをちょうど1つ要求する。`--match-head-commit`でchecked PR headにmergeをbindし、pending、failed、cancelled、skipped、missing、ambiguousな`validate` resultは拒否する。このnormal pathをdirect `gh pr merge`、`--admin`、`--auto`で置き換えてはならない。

Repository visibilityとbranch-protection capabilityはdated GitHub API snapshotとしてのみ記録し、current-state guaranteeとはしない。merge boundaryを信頼する前にlive repositoryを再検証する。したがってlocal commandはnormal merge pathを改善するが、direct/force pushやprivileged API、administrator bypassは防げない。repository visibility、GitHub plan、external cost、permissionsの変更にはHuman Decisionが必要である。[詳細](docs/scwbs/merge-protection.md)を参照する。

Unattended executionはTaskごとの明示的な例外である。Task Contractには、delegator、AI target、allowed scopes（`human-gate`および/または`post-finish`）、source、reason、expiry、external tokenのSHA-256 hashを持つlockedな`approvalPolicy.mode: delegated` policyが必要である。token自体は`SCWBS_APPROVAL_DELEGATION_TOKEN`だけから供給し、contractsやApproval recordへcommitまたは保存してはならない。

```bash
SCWBS_APPROVAL_DELEGATION_TOKEN="<secret>" \
  npm run scwbs -- approval approve --task <task-id> --pull-request "#<number>" \
  --actor delegated-ai --scope post-finish --reason "Authorized unattended execution"
```

環境変数の管理にはlocal `.env` fileやCI secret storeを使えるが、CLIは`.env`を自動loadせず、`.env`だけでauthorityが付与されることもない。少なくとも32 bytesのrandom tokenを使う。そうしなければcontractに公開されたSHA-256から弱いsecretをoffline guessingできる。committed Task Contract policyと一致する未期限切れtokenの両方が必要である。Delegated recordは`approvalMode: delegated`とtoken-derived `delegationProof`を使い、declared source、delegator、executor、scopeをhuman approvalとは別に記録する。consumerはproofを再検証し、`human-gate`はHuman Gate checkに、`post-finish`はcompletionにのみ受け入れる。これらのcontrolは偶発的または単純なYAML bypassを大幅に困難にするが、`delegatedBy`の現実のidentity、tokenをprovisionした人、codeとlocal secretをともに書き換えられるfully privileged processを独立して検証するものではない。

## 6. Core Artifacts

- Task Contract: `contracts/tasks/<task-id>.yaml`
- Evidence: `contracts/evidence/<task-id>.yaml`
- Approval: `contracts/approvals/<task-id>.yaml`
- Block: `contracts/blocks/<task-id>.yaml`
- Registry: `contracts/registry.yaml`

## 7. Profiles

Profiles tune validation strictness:

```bash
npm run scwbs -- profile show
npm run scwbs -- profile set lean
npm run scwbs -- profile set standard
npm run scwbs -- profile set strict
```

小さなlocal dogfood taskには`lean`、通常のrepository workには`standard`、広いgovernance checkが必要な場合には`strict`を使う。`profile set`は`contracts/changesets/`配下へ`setDocumentExtension` changesetを書き、WJS経由でapplyする。canonical WBSを直接編集しない。profileはglobal Task lockに参加するため、変更後に`npm run scwbs -- task refresh --affected`をreviewする。

## 8. Common Errors

- `allowedPaths`外: stopし、変更を狭めるか、編集前にTask Contractを更新する。
- `forbiddenPaths`配下: stopしてblockする。forbidden pathはallowed pathより優先される。
- Human Gate required: stopして`block`を使う。
- Stale Evidence: final diffを確定してから`finish`を再実行する。
- Stale Approval scope: 人間がcurrent diffを再reviewしてapproveする必要がある。

## 9. Developer Commands

小さなtaskを作成する。

```bash
npm run scwbs -- task new "Update docs" --paths "docs/scwbs/getting-started.md" --stop "source change required"
```

Task Contractに表示されたbranchへ切り替える。

```bash
git switch -c <branchName>
```

テストは2つのgroupに分かれる。

- `tests/unit/` – default `npm test` commandで使うfastかつlightweightなtest。
- `tests/integration/` – temporary Git repositoryを作成するheavyなtest。

Coverage commandも同じ2つのscopeを使う。

- `npm run test:coverage` – fastなunit-only coverage。
- `npm run test:coverage:all` – V8 providerを使うunit/integration combined coverage。reportとmachine-readable inputは`coverage/`へ書き込む。意図的に大きいreceipt-bound stress caseは、synchronous filesystem workloadよりper-test timeoutが短いため、このinstrumented runから除外する。complete integration suiteは`npm run test:integration`で引き続きcoverage対象である。
- CIはそのinputを`coverage/coverage-receipt.json`と`coverage/evidence-snapshot.json`へ変換する。receiptはtest count、skip reason、Statements/Branches/Functions/Lines metric、PR/head/workflow/artifact provenance、payload digestを記録する。verified receiptを通常のTask Evidenceへ添付するには`npm run scwbs -- evidence collect --task <task-id> --pull-request <number> --coverage-receipt coverage/coverage-receipt.json`を使う。head、PR、repository、workflow provenanceが一致しない場合は拒否する。workflowはartifactをuploadしread-only permissionを保持するだけで、Evidenceをpushしたりcoverage thresholdをenforceしたりしない。

local verification set全体を実行する。

```bash
npm test                    # unit tests only (fast)
npm run test:integration    # integration tests (heavier)
npm run test:all            # all tests
npm run test:coverage       # unit-only coverage (fast)
npm run test:coverage:all   # unit and integration coverage
npm run lint                # ESLint gate (--max-warnings=0; historical counts are not authoritative)
npm run format              # format source, tests, scripts, docs, and root config files
npm run typecheck
npm run build
npm run scwbs -- check
npm run scwbs -- finish --task <task-id>
npm run scwbs -- registry rebuild --check
```

`npm run typecheck`はproduction TypeScript、test TypeScript、`scripts/`のdependency-free JavaScript runnerという3つのcheckを順に実行する。production buildは引き続き`tsconfig.json`を使う。test codeはoutputなしで`tsconfig.tests.json`を使い、scriptは`checkJs`付きの`scripts/tsconfig.json`を使う。implicit JavaScript parameter typeはdocumentされたmigration boundaryとして残るが、その他のinferred type errorは検査する。

`npm run lint`は`src/`、`tests/`、`scripts/`向けのESLint flat configを使い、`package.json`でcurrent zero-warning thresholdを設定する。Historical warning countはactive acceptance criterionではない。`package.json`で`--max-warnings=0`を設定しているため、current commandはwarningが1つでもあれば失敗する。このgateを変更する場合は本文も更新する。Individual ruleをerrorへ昇格する場合は、後続の別scope変更で行う。このtaskでは既存sourceをbulk rewriteしない。Prettierは明示的な`npm run format` write commandで利用でき、CIでは自動実行しない。

decision point付きのwalkthroughには`docs/scwbs/getting-started.md`を使う。

## AI agentがしてはならないこと

- Task Contractなしで作業しない。
- `allowedPaths`外のfileを変更しない。
- `forbiddenPaths`を変更しない。
- implementation noteやchatをGround Truthとして扱わない。
- 人間に代わってHuman Gate decisionをapproveしない。
- Evidenceと`check-diff`がpassするまでtaskをDoneとしない。

current repository-specific ruleは`AGENTS.md`にある。

## Current Command Surface

このrepositoryで作業する間は、すべてのCLI commandをnpm script経由で実行する。

```bash
npm run scwbs -- --help
```

Common command:

```bash
npm run scwbs -- next
npm run scwbs -- task new "作業名" --paths "src/commands/example.ts,tests/integration/example.test.ts" --stop "schema or dependency change required"
npm run scwbs -- task start <task-id>
npm run scwbs -- project bootstrap "<goal>"
npm run scwbs -- packet --task <task-id>           # tiny (default)
npm run scwbs -- packet --task <task-id> --standard
npm run scwbs -- packet --task <task-id> --full
npm run scwbs -- ai packet --task <task-id> --relation-depth 1
npm run scwbs -- finish --task <task-id>           # standard completion command
npm run scwbs -- block "Human Gate required" --task <task-id>
npm run scwbs -- request-approval --task <task-id> --pr <number>
```

詳細なexampleは`docs/scwbs/cli-reference.md`にある。

## Repository Layout

```text
.
├── src/                     # scwbs CLI source
├── tests/
│   ├── unit/                # fast unit tests (npm test)
│   ├── integration/         # heavier integration tests (npm run test:integration)
│   └── helpers.ts           # shared test utilities
├── contracts/               # SC-WBS contracts for this repository
├── docs/
│   ├── scwbs/               # current user and tool docs
│   ├── sc-wbs-core/         # lightweight Core documentation pack
│   └── sc-wbs-core-revision/ # draft revision notes, not current rules
├── wjs/                     # WBS-JSON submodule (contributor checkout)
├── package.json
└── tsconfig.json
```

## 正本

状態: 現行リポジトリの入口。

- 現行の実行ルール: `AGENTS.md`とactive Task Contract。
- Taskの範囲: `contracts/tasks/<task-id>.yaml`。
- 完了Evidence: `contracts/evidence/<task-id>.yaml`。
- 文書マップ: `docs/README.md`。
- 現行Coreのリファレンス: `docs/sc-wbs-core/00-index.md`。
- Legacy / 詳細リファレンス: `docs/scwbs/`。
- Proposal / 設計ノート: `docs/sc-wbs-core-revision/`。
- 正規artifactのschema: `src/core/schema/records.ts`（AJV JSON Schema）。
  - `ApprovalRecord`: top-levelの`pullRequest`、`headCommit`、`diffHash`を持つflat structure（nested `scope`は持たない）。
  - `BlockRecord`: `level`、`category`、`requiredHumanDecision`、`createdAt`を要求し、`history[]`はoptional。
  - Schema versionは`contracts/wbs/project.wbs.json`の`schemaVersion`に従う。

実作業中にこれらが食い違う場合は、`AGENTS.md`とactive Task Contractを優先する。

## MVP Scope

v0.1で実装済み:

- Contract、Evidence、WBS、diff、healthの検証。
- AI work packet、Review queue、Approval request、軽量なorchestration helper。
- packaged runtimeを備えたWJS-backed WBS validation、semantic operation application、changeset check。
- WBS-less task index operation、WBS candidate generation、WBS changeset reproduction check。
- branchごとのTask safeguardとEvidenceのGit metadata。
- Text-first dashboard、trace、next-action、profile、registry、draft-generation command。

まだ含まれないもの:

- 初期のtext dashboardと`serve` stubを超えるWeb UI。
- SQLiteによるindex。
- 外部利用者向けinstaller体験の完全版。
