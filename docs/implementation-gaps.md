# 実装上のギャップ

この表は、現在の MVP で未完了または継続確認が必要な機能を日本語で管理する。

この文書は、現在のMVPで意図的に未完了として残している項目を追跡する。

## 実装済み

- 構造的な契約検証を行う`scwbs check`
- 基本的な鮮度と信頼性の警告を行う`scwbs health`
- Task ContractとEvidenceの検証
- WBS nodeからTask Contractのdraftを生成する機能
- Git diffのpath検査
- `relation-depth`で関連範囲を絞ったAI Work Packet生成
- Contract Lock metadataの任意検証
- WBSとSpecのcontent hashからTask Contract Lockを生成する機能
- required metadata検証付き`contracts/specs/*.yaml`のfirst-class Spec Contract file

<!-- scwbs-capability: spec-change-proposal status=implemented -->

- first-class Spec Change Proposal fileと、Level 2 request routing付き`scwbs spec-change new`の生成
- Evidence `testQuality` metadataの検証
- `base`と`head`を考慮したEvidenceのchanged file収集
- EvidenceへのPR metadataの記録とrefresh後の保持
- EvidenceへのtestQuality metadataの記録とrefresh後の保持
- staleなTask Contract Lockの検出とrefresh方針（`task refresh --task`、`--affected`、明示的な`--all --apply`）
- lockのみを更新するrefreshのHuman Gate境界。refreshはTask authority fieldを変更せず、semantic contract changeをapproveしない
- squash merge後のtracked patch Evidence保持とsubject再構成
- health/statusでpatch provenanceをfail-closedに検証する機能
- `evidence retain`による範囲を限定したlegacy Evidence移行
- `evidence prune`によるread-onlyのEvidence保持状況一覧とprune計画（現在のbaseline: 148 tracked payloads / 5,933,400 bytes）。削除、external archiveの耐久性、監査上の信頼性変更、Git history rewriteは人間の判断事項として残る
- AIがblocked task用のchangesetを生成する機能
- simple queue handoff向けに依存関係を考慮したplanned task候補を一覧化する機能
- `ai next-task`によって優先度を考慮したplanned task候補を一覧化する機能
- Codex/Claude/Cursor/Copilotに対応し、Gemini CLI/OpenCodeのpreview fixture、capability/locale metadata、divergence-aware `init` / `update` generationを備えた、バージョン管理されたデータ駆動型AI tool adapter registry
- digest lock、local pinned Git ref、additive-only policy merge、discovery-only installed catalogを備えた、バージョン管理されたGovernance Pack v1のinspection/install/update/remove dry-run
- バージョン管理されたresource/tool、既存evaluatorの再利用、上限付きprotocol output、人間専用operationの除外を備えた、依存関係のないstdio-only MCP server

<!-- scwbs-capability: local-index status=implemented -->

- provenanceを考慮したstatus、範囲を限定したcross-artifact query、stale/corrupt recovery、non-authoritative cache semanticsを備えたrebuildable Node SQLite local index
- `scwbs health`によるwarning-only code-versus-contract timestamp drift detection
- check-diffのsensitive meta/config file guardrail
- subtree-scoped bootstrap phase metadataとAI packet reporting
- <!-- scwbs-capability: wbs-semantic-merge status=implemented --> read-only WBS semantic merge planningとexplicit clean-plan changeset generation
- `contracts/wbs/project.wbs.json`とactive Task Contractによるrepository dogfooding
- WBSの状態サマリー
- WJSのsemantic apply wrapper
- CIに保持されるreportとmachine-readable Evidence snapshotを含むunit/integration test coverageの計測
- バージョン管理されたdeclarative artifact workflow schema、fail-closed DAG validation、read-only `scwbs artifact status/instructions`。workflow guidanceはadvisoryであり、Task authority、Human Gate、required check、Evidence provenanceを緩和できない
- deterministicなSpec/Task/WBS inventory、5つのroute outcome、brief/roadmap output、cross-Spec boundary review、provenanceを備えた、バージョン管理されたread-only Discovery routing proposal。route outputはdelivery authorityを変更しない
- absolute-root resolution、repository trust、pinned shared Spec provenance、stale/path/cycle check、repository-local Task/Evidence/CI authorityを備えた、バージョン管理されたread-only Planning Store registry。remote Gitとcredential automationは除外する
- one-Task implementer/checks/fresh-reviewer orchestration、two-round cap付きバージョン管理Phase 2 debugger/remediation receipt、stale resume validation、shell-free adapter invocation、provider capability validation、範囲を限定したadvisory learned note、local execution cost metric、fail-closed authority/Human Gate boundaryを備えたbounded AI execution runner。PRとmerge automationは除外する
- exact version check、release-manifest subject/digest verification、offline tarball verification、read-only upgrade proposalを備えたfirst-class release lifecycle UX。npm publicationとunattended upgradeは人間の判断事項として残る
- WJS operations validationはfail-closedであり、missingまたはunusable canonical validationがpermissive local fallbackへdowngradeされず、`doctor`も同じrepair boundaryを報告する
- segment-aware globstar semanticがzero-directory/nested-directory matchとshared path normalizationをカバーし、unsupported authority syntaxはcheck-diffでrejectされる
- Finish PR readinessがmerge preflight evaluatorを再利用してmachine-readable `mergeReadiness`を公開し、pending、neutral、skipped、wrong-workflow、duplicate、failedな`validate` checkはmerge-readyにならない
- Doctorが`engines.npm`、Corepack availability、pinned `packageManager`、workspace dependency graph healthを検証し、repair planがdeclared npm pinを尊重する
- read-only `task preflight`と`policy explain`がTask authorityを変更せずrequired check、Evidence、Human Gate path、forbidden path、policy reason codeをderiveする
- versioned Risk Register v1がbounded `risk list/show/add/update/accept`、fixed likelihood × impact scoring、Strict fail-closed treatment/acceptance check、Evidence-bound acceptance freshness、trace relationを提供する。risk acceptanceはHuman-onlyとして残る
- local read-only `scwbs serve`が、既存UI/trace evaluatorを投影するoffline localhost dashboardをbounded GET route、CSP、secret filtering、write authorityなしで提供する
- read-only GitHub Issue intakeがdigest/stale provenance付きbounded normalized snapshotとdry-run Discovery candidateを提供する。GitHub write-backとTask auto-promotionはHuman-onlyとして残る
- docs checkがorphan Markdownとselected factual driftを検出し、repository capability proseをdated snapshotとして扱う

## 未実装

| 領域 | 未対応項目 | 重要性 |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change control | Spec Change workflow enforcement | <!-- scwbs-capability: spec-change-workflow-enforcement status=missing --> Proposal creationとLevel 2 request routingは存在するが、より広いworkflow enforcementが未完了である |
| Evidence trust | External artifact signatureとindependent CI attestation | `evidence verify-attestation`は範囲を限定したGitHub Artifact Attestation verification summaryを記録するが、workflow permission、trust-root adoption、release publicationはHuman-onlyとして残る |
| Evidence diff basis | Independent external artifact signatureとpublish-time promotion policy | `evidence import-ci`は範囲を限定したPR readiness artifactを検証し、`evidence verify-attestation`は正確なartifact digestとsubject identityを検証する。automatic promotionは対象外である |
| Test quality | Diff-aware assertionとcoverage inspection | Phase 1はchanged test file、added skip/only/todo marker、verified base receiptがある場合のfail-safe line-coverage deltaを記録する。AST assertion countとthreshold gateは意図的に対象外である |
| Review independence | Human review transitionとexternal reviewer promotion | Phase 1はfresh reviewer resultを収集できるが、human-only Review transitionを作成せず、reviewer resultをcompletionへpromoteしない |
| CI integration | Independent attestationとautomatic promotion | trusted `workflow_run` reportingと範囲を限定したexternal verifierがprovenance evidenceを提供する。workflow permission、automatic Approval/Review/merge、unbounded annotationは意図的に除外する |
| WBS collaboration | Distributed WBS support | <!-- scwbs-capability: wbs-distributed-support status=missing --> Full distributed collaborationはread-only semantic merge plannerの対象外として残る |

## 近い将来のフォローアップ

- Proposal creationとLevel 2 request routingを超えてSpec Change workflow enforcementを拡張する。
- 実行可能な範囲で`testQualityObservation`へAST-based assertion countを追加する。Phase 1はmanual `testQuality` metadataを置き換えず、test diffとverified coverage summaryを比較する。
- read-only WBS semantic merge planningをdistributed WBS supportへ拡張する。
- patch-retention merge後にread-only inventoryを実行し、記録されたsubject、base、diffHash、changedFilesを再現できるhistorical Evidenceだけをbackfillする。
- `npm run scwbs -- evidence prune --json`で現在のtracked payload inventoryを確認する。このcommandは意図的にread-onlyであり、archived Task candidateを報告するが、cutoff選択、payload削除、archive upload、Git history rewriteは行わない。
- release workflow permissionとattestation generationは、別途approveされたthreat model、repository-plan review、Human Gateの後にだけ追加する。このTaskは`.github` workflowを変更しない。
