# SDDベンチマークスイート

Issue #541では、ACED、OpenSpec、GitHub Spec Kit、cc-sddを対象とする、バージョンを固定した手動またはopt-in方式のreplay harnessを追加する。

## 安全性の境界

ベンチマークは計測用artifactであり、権威ソースではない。既定のrunnerはplan-onlyで動作し、competitor commandの実行、latest versionの解決、他repositoryの変更、ACED checkの迂回、Approvalの作成、roadmap decisionの生成を行わない。外部setup、credential、network access、version change、executionは、人間による明示的な判断またはopt-in decisionが必要な操作として残す。

## Manifestとpin

正本manifestは[`../../benchmarks/sdd/manifest.json`](../../benchmarks/sdd/manifest.json)である。各toolはrepository、version field、40文字のcommitによってpinする。pinはimmutableな入力データであり、runnerはrefreshしない。

現行manifestには、ACED `0.1.0`として`ed690419928639eba8ae47d2eed8dc0ea4cc7a34`、OpenSpecとして`e50bd0983dc8dc48250e3181f36e28450542f2ab`、GitHub Spec Kitとして`bd595cf838cc200f84fee9e9327b643dfe277d2c`、cc-sddとして`29aee950f4addc36f9aeecb9881c46540e71ecc9`を記録している。pinの更新には、review済みのmanifest変更と新しいbenchmark reportが必要である。

## シナリオ

- `docs-only`: 初回利用時のつまずきと完了処理の負荷。
- `ordinary-feature`: spec → task → implementation → verificationの一連の流れ。
- `dangerous-auth-config`: 範囲外の編集、required checkの欠落、自己承認、古いEvidenceの再利用。

fixtureは`benchmarks/sdd/fixtures/`配下に置くrepository-independentなJSON inputである。competitor commandやcredentialは含めない。

## 実行モード

Plan-only modeでは、`N/A`の結果を含む上限付きreportを作成し、外部実行は行わない。

```bash
node benchmarks/sdd/runner.mjs --out-dir benchmarks/sdd/reports
```

manual observationは同じreport shapeへnormalizeできる。observation fileは`scwbs.sdd-benchmark.observation.v1`、`shell: false`付きのstructured `argv` array、上限付きlogを使用し、tool/scenario pairごとに1 entryを持たなければならない。

```bash
node benchmarks/sdd/runner.mjs --observations path/to/observations.json --out-dir benchmarks/sdd/reports
```

runnerは`report.json`と`report.md`を書き出す。setup failureまたはunsupported capabilityは`N/A`、観測されたsafety violationは`FAIL`として扱う。raw metricとcommand logはoptional subjective scoreと分離して保持する。missing、malformed、oversized、duplicate、shell-string observationはfail-closedで拒否する。

reportは人間による比較専用であり、security guaranteeを公開せず、winnerを選ばず、roadmap Issueを自動作成しない。CI executionは意図的にmanualまたはopt-inとする。
