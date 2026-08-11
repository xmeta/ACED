# GitHub Issue intake

GitHub Issues are an optional, read-only discovery input. They are not Task Contracts, approvals, or policy documents.

```bash
npm run scwbs -- intake github-issue 123 --json
npm run scwbs -- discovery from-github-issue 123 --dry-run --json
```

The intake adapter uses `gh issue view` with structured argument arrays and a bounded output buffer. It normalizes repository, number, title, body, labels, author, timestamps, state, source URL, a canonical SHA-256 digest, and `observedAt`. Issue body and metadata are explicitly untrusted fields; prompt-like text cannot authorize commands or change SC-WBS policy.

The Discovery projection is always `discovery-only`. It does not write a Probe in dry-run mode, create or approve a Task Contract, write comments, close Issues, or persist credentials. An optional `--expected-digest` turns an updated snapshot into a machine-readable `stale` result. Missing GitHub access, malformed payloads, foreign repositories, and unavailable authentication are reported without breaking local workflows.
