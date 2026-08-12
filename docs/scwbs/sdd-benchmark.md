# SDD benchmark suite

Issue #541は、ACED、OpenSpec、GitHub Spec Kit、cc-sdd向けにversion-pinnedでmanualまたはopt-inなreplay harnessを追加する。

## 安全性の境界

benchmarkはmeasurement artifactでありauthority sourceではない。default runnerはplan-onlyで、competitor commandの実行、latest versionのresolve、他repositoryの変更、ACED checkのbypass、approval作成、roadmap decision generationを行わない。external setup、credential、network access、version change、executionは明示的なhumanまたはopt-in decisionとして残る。

## Manifestとpin

canonical manifestは[`../../benchmarks/sdd/manifest.json`](../../benchmarks/sdd/manifest.json)である。各toolをrepository、version field、40文字commitでpinする。pinはimmutable input dataであり、runnerはrefreshしない。

current manifestはACED `0.1.0`を`ed690419928639eba8ae47d2eed8dc0ea4cc7a34`、OpenSpecを`e50bd0983dc8dc48250e3181f36e28450542f2ab`、GitHub Spec Kitを`bd595cf838cc200f84fee9e9327b643dfe277d2c`、cc-sddを`29aee950f4addc36f9aeecb9881c46540e71ecc9`へ記録する。pin updateにはreviewed manifest changeとnew benchmark reportが必要である。

## シナリオ

- `docs-only`: first-run frictionとcompletion overhead。
- `ordinary-feature`: spec → task → implementation → verification。
- `dangerous-auth-config`: out-of-scope edit、required-check omission、self-approval、stale-evidence reuse。

fixtureは`benchmarks/sdd/fixtures/`配下のrepository-independent JSON inputである。competitor commandやcredentialを含まない。

## 実行モード

Plan-only modeは`N/A` result付きbounded reportを作成し、external executionを行わない。

```bash
node benchmarks/sdd/runner.mjs --out-dir benchmarks/sdd/reports
```

manual observationは同じreport shapeへnormalizeできる。observation fileは`scwbs.sdd-benchmark.observation.v1`、`shell: false`付きstructured `argv` array、bounded log、tool/scenario pairごとに1 entryを使わなければならない。

```bash
node benchmarks/sdd/runner.mjs --observations path/to/observations.json --out-dir benchmarks/sdd/reports
```

runnerは`report.json`と`report.md`を書き出す。setup failureまたはunsupported capabilityは`N/A`、観測されたsafety violationは`FAIL`である。raw metricとcommand logはoptional subjective scoreと分離して保持する。missing、malformed、oversized、duplicate、shell-string observationはfail-closedになる。

reportはhuman comparison専用であり、security guaranteeをpublishせず、winnerを選ばず、roadmap Issueを自動作成しない。CI executionは意図的にmanualまたはopt-inである。
