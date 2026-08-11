# scwbs Consumer Quickstart

This is the clone-free, finish-first path for a first-time consumer. It uses
the installed `scwbs` CLI and keeps repository contributor setup separate. A
small docs-only task can reach its first governed completion in about ten
minutes.

## 1. Install the release tarball

The supported consumer artifact is the self-contained tarball attached to a
GitHub Release. It includes the WJS validator and does not require an ACED
checkout or the `wjs` submodule.

```bash
SCWBS_VERSION=0.1.0
npm install --save-dev "https://github.com/xmeta/ACED/releases/download/v${SCWBS_VERSION}/scwbs-${SCWBS_VERSION}.tgz"
npx scwbs --version
```

For a local smoke test, build and pack the repository first, then install the
resulting `.tgz` into an empty consumer project as described in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## 2. Initialize and orient yourself

```bash
npx scwbs init --profile lean --agent codex --lang en
npx scwbs doctor
npx scwbs next
npx scwbs next --json
```

`doctor` diagnoses the local installation. `next` is the canonical navigation
command when the next step is unclear; use `--json` for an IDE or automation.

## 3. Create, edit, and finish one small task

Create a Task Contract with the smallest allowed scope, then use the exact
branch name printed by `task new`:

```bash
npx scwbs task new "Improve a consumer-facing document" \
  --paths "docs/example.md" \
  --stop "source or schema change required"
npx scwbs task start <task-id>
```

Make the change, inspect it, and commit the implementation. The standard
completion command is:

```bash
npx scwbs finish --task <task-id>
```

`finish` runs the Task's required checks, collects Evidence, checks the diff
against the contract, and verifies the registry. Follow its typed next action
for PR metadata, review, approval, and merge. Do not reconstruct that ceremony
from a long manual command chain unless troubleshooting requires it.

## 4. Human Gate boundary

If `finish` reports that a Human Gate is required, an AI must stop. A human
reviews the current diff and Evidence, then runs the exact approval command
shown by the CLI. Lean tasks may require copying an exact TTY confirmation into
`--reason`:

```bash
npx scwbs approval approve \
  --task <task-id> \
  --actor human \
  --reason "<exact confirmation printed by scwbs>"
```

An AI must not substitute `--actor human`, approve its own work, or broaden a
Task Contract to avoid the gate.

## 5. Contributor and advanced paths

This quickstart is for an installed consumer. Contributors working in the ACED
repository should use [`CONTRIBUTING.md`](../../CONTRIBUTING.md), then read the
advanced repository flow in [`getting-started.md`](getting-started.md) when
needed. That flow intentionally retains manual checks, Evidence/registry
repair, `check-diff`, review, and troubleshooting details for diagnosis and
maintenance; it is not the first-use happy path.
