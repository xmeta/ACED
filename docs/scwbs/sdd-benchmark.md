# SDD benchmark suite

Issue #541 adds a version-pinned, manual or opt-in replay harness for ACED, OpenSpec, GitHub Spec Kit, and cc-sdd.

## Safety boundary

The benchmark is a measurement artifact, not an authority source. The default runner is plan-only and never executes a competitor command, resolves a latest version, changes another repository, bypasses ACED checks, creates approvals, or generates roadmap decisions. External setup, credentials, network access, version changes, and execution remain explicit human or opt-in decisions.

## Manifest and pins

The canonical manifest is [`../../benchmarks/sdd/manifest.json`](../../benchmarks/sdd/manifest.json). It pins each tool by repository, version field, and 40-character commit. Pins are immutable input data; the runner never refreshes them.

The current manifest records ACED `0.1.0` at `ed690419928639eba8ae47d2eed8dc0ea4cc7a34`, OpenSpec at `e50bd0983dc8dc48250e3181f36e28450542f2ab`, GitHub Spec Kit at `bd595cf838cc200f84fee9e9327b643dfe277d2c`, and cc-sdd at `29aee950f4addc36f9aeecb9881c46540e71ecc9`. Updating a pin requires a reviewed manifest change and a new benchmark report.

## Scenarios

- `docs-only`: first-run friction and completion overhead.
- `ordinary-feature`: spec → task → implementation → verification.
- `dangerous-auth-config`: out-of-scope edits, required-check omission, self-approval, and stale-evidence reuse.

Fixtures are repository-independent JSON inputs under `benchmarks/sdd/fixtures/`. They do not contain competitor commands or credentials.

## Run modes

Plan-only mode creates a bounded report with `N/A` results and no external execution:

```bash
node benchmarks/sdd/runner.mjs --out-dir benchmarks/sdd/reports
```

Manual observations can be normalized into the same report shape. The observation file must use `scwbs.sdd-benchmark.observation.v1`, structured `argv` arrays with `shell: false`, bounded logs, and one entry per tool/scenario pair:

```bash
node benchmarks/sdd/runner.mjs --observations path/to/observations.json --out-dir benchmarks/sdd/reports
```

The runner writes `report.json` and `report.md`. Setup failure or unsupported capability is `N/A`; an observed safety violation is `FAIL`. Raw metrics and command logs are preserved separately from optional subjective scores. Missing, malformed, oversized, duplicate, or shell-string observations fail closed.

Reports are for human comparison only. They do not publish a security guarantee, select a winner, or create roadmap Issues automatically. CI execution is intentionally manual or opt-in.
