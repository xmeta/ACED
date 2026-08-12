# Integration testの実行

`npm run test:integration`はbounded duration reporterを通して`tests/integration` gate全体を実行する。failed testのretryは行わない。

## Parallelismとisolation

Vitestは`forks` poolを使い、test fileを2–4 worker（logical CPUが4以上のmachineでは既定4）でparallelizeする。file内のtestはserialのままである。複数testがprocess-global stateを一時的に置き換えるため、このboundaryが重要である。

- `tasks.test.ts`: `process.chdir`
- `approval.test.ts`と`review.test.ts`: `process.env`
- `ai`、`check`、`doctor`、`evidence`、`finish`、`health`、`misc`、`review`: consoleまたはprocess stdout/stderr

fork-per-file boundaryがこれらのmutationをisolateする。temporary Git repositoryは`makeTempRepo`によりtestごとにuniqueなので、file間のGit fixtureはparallel-safeである。対象testを`test.concurrent`へ変えてはならない。file内ではprocess-global mutationのためserialが必要である。

`checks-run.test.ts`も同じboundaryに従う。6 caseは別temporary repositoryを使うが、各caseは複数Git setup operation、npm child process、required-check receiptとlock/lease pathを実行する。そのため、CPU、filesystem、process table、child-process pressureでexact-receipt scenarioがtimeoutにならないようfile内ではserialにする。file-level parallelismと既定2–4 workerは有効なままである。testはcase phase、test-worker PID、temporary repository、child-process command、lock/lease state、receipt presenceを含むbounded failure diagnosticを登録する。

## 実行時間レポート

既定outputはtotal 1行、slowest 5 file、slowest 5 testへboundedする。file/test durationを持つreproducible JSON reportは、suiteを再実行せずに次で書き出せる。

```bash
npm run test:integration -- --report /tmp/scwbs-integration-duration.json
```

各bounded listは`--slowest 0..20`で変更でき、worker settingは`--workers N`（`2 <= N <= 4`）または`SCWBS_INTEGRATION_WORKERS=N`で再現できる。

failure時のdefault modeは、failed test nameを最大5件、boundedな1行cause、copy可能なsingle-test rerun command、元のbyte count付きbounded stdout/stderrを表示する。full Vitest/CLI outputは明示的に要求した場合だけ利用できる。

```bash
npm run test:integration:verbose
```

unit regression suiteはrepresentative successful outputを11行 / 2,048 bytes、representative failure diagnosticを10行 / 6,000 bytesに固定する。これにより、review可能なtest changeなしにsuccessful CLI outputとlarge failure payloadがAI/CI logへ増え続けることを防ぐ。

Issue #190のpre-change local baselineはone workerで276.02–277.33秒だった。final four-worker validationは257 testを116.99秒で完了し、276.02秒のbaselineから57.6%短縮した。GitHub Actionsは同じ`test:integration` scriptを呼ぶため、full integration coverage gateは変わらない。
