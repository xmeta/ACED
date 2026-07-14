# Integration test execution

`npm run test:integration` runs the complete `tests/integration` gate through a bounded duration reporter. It does not retry failed tests.

## Parallelism and isolation

Vitest uses the `forks` pool and parallelizes test files with 2–4 workers (4 by default on a machine with at least 4 logical CPUs). Tests inside a file remain serial. This boundary matters because several tests temporarily replace process-global state:

- `tasks.test.ts`: `process.chdir`
- `approval.test.ts` and `review.test.ts`: `process.env`
- `ai`, `check`, `doctor`, `evidence`, `finish`, `health`, `misc`, and `review`: console or process stdout/stderr

The fork-per-file boundary isolates those mutations. Temporary git repositories are unique per test through `makeTempRepo`, so git fixtures are parallel-safe across files. Do not convert the affected tests to `test.concurrent`; their process-global mutations are serial-required within their file.

## Duration report

The default output is bounded to one total line, the slowest five files, and the slowest five tests. A reproducible JSON report with file and test durations can be written without running the suite again:

```bash
npm run test:integration -- --report /tmp/scwbs-integration-duration.json
```

Use `--slowest 0..20` to change each bounded list and `--workers N` (`2 <= N <= 4`) or `SCWBS_INTEGRATION_WORKERS=N` to reproduce a worker setting.

On failure, the default mode prints at most five failed test names, a bounded one-line cause, a copyable single-test rerun command, and bounded stdout/stderr with their original byte counts. Full Vitest and CLI output is available only when explicitly requested:

```bash
npm run test:integration:verbose
```

The unit regression suite fixes the representative successful output budget at 11 lines / 2,048 bytes and the representative failure diagnostics at 10 lines / 6,000 bytes. This prevents successful CLI output and large failure payloads from growing AI or CI logs without a reviewable test change.

The pre-change local baseline recorded for Issue #190 was 276.02–277.33 seconds with one worker. The final four-worker validation completed all 257 tests in 116.99 seconds, a 57.6% reduction from the 276.02-second baseline. GitHub Actions continues to call the same `test:integration` script, so the full integration coverage gate is unchanged.
