# GitHub Issueの取り込み

GitHub Issueはoptionalかつread-onlyなDiscovery inputである。Task Contract、approval、policy documentではない。

```bash
npm run scwbs -- intake github-issue 123 --json
npm run scwbs -- discovery from-github-issue 123 --dry-run --json
```

intake adapterはstructured argument arrayとbounded output bufferで`gh issue view`を使う。repository、number、title、body、label、author、timestamp、state、source URL、canonical SHA-256 digest、`observedAt`をnormalizeする。Issue bodyとmetadataは明示的にuntrusted fieldであり、prompt-like textはcommand実行やSC-WBS policy変更をauthorizeできない。

Discovery projectionは常に`discovery-only`である。dry-run modeではProbeを書かず、Task Contractをcreateまたはapproveせず、commentを書かず、Issueをcloseせず、credentialをpersistしない。optionalな`--expected-digest`により、updated snapshotをmachine-readableな`stale` resultへ変換できる。GitHub access不足、malformed payload、foreign repository、unavailable authenticationはlocal workflowを壊さず報告する。
