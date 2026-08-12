# 実装上のギャップ

この表は、現在の MVP で未完了または継続確認が必要な機能を日本語で管理する。

この文書は、current MVPで意図的に未完了として残る項目を追跡する。

## 実装済み

- 構造的なcontract validationを行う`scwbs check`
- basic freshnessとtrust warningを行う`scwbs health`
- Task ContractとEvidenceのvalidation
- WBS nodeからのTask Contract draft generation
- Git diff path check
- relation-depth filtering付きAI Work Packet generation
- optional Contract Lock metadata validation
- WBSとSpecのcontent hashからのTask Contract Lock generation
- required metadata validation付き`contracts/specs/*.yaml`のfirst-class Spec Contract file

<!-- scwbs-capability: spec-change-proposal status=implemented -->

- first-class Spec Change Proposal fileと、Level 2 request routing付き`scwbs spec-change new` creation
- Evidence `testQuality` metadata validation
- base/head-awareなEvidence changed file collection
- Evidence PR metadataのcaptureとrefresh preservation
- Evidence testQuality metadataのcaptureとrefresh preservation
- stale Task Contract Lock detectionとrefresh policy（`task refresh --task`、`--affected`、明示的な`--all --apply`）
- lock-only refreshのHuman Gate boundary。refreshはTask authority fieldを変更せず、semantic contract changeをapproveしない
- squash merge後のtracked patch Evidence retentionとsubject reconstruction
- health/statusでのfail-closed patch provenance verification
- `evidence retain`によるbounded legacy Evidence migration
- `evidence prune`によるread-only Evidence retention inventoryとprune planning（current baseline: 148 tracked payloads / 5,933,400 bytes）。削除、external archive durability、audit trust change、Git history rewriteはHuman Decision workとして残る
- AIのblocked task向けchangeset生成
- simple queue handoff向けの依存関係対応planned-task候補一覧
- `ai next-task`による優先度対応planned-task候補一覧
- Codex/Claude/Cursor/Copilot対応、Gemini CLI/OpenCode preview fixture、capability/locale metadata、divergence-aware `init` / `update` generationを備えたversioned data-driven AI tool adapter registry
- digest lock、local pinned Git ref、additive-only policy merge、discovery-only installed catalogを備えたversioned Governance Pack v1のinspection/install/update/remove dry-run
- versioned resource/tool、existing evaluator reuse、bounded protocol output、Human-only operation exclusionを備えたdependency-free stdio-only MCP server

<!-- scwbs-capability: local-index status=implemented -->

- provenance-aware status、bounded cross-artifact query、stale/corrupt recovery、non-authoritative cache semanticsを備えたrebuildable Node SQLite local index
- `scwbs health`によるwarning-only code-versus-contract timestamp drift detection
- check-diffのsensitive meta/config file guardrail
- subtree-scoped bootstrap phase metadataとAI packet reporting
- <!-- scwbs-capability: wbs-semantic-merge status=implemented --> read-only WBS semantic merge planningとexplicit clean-plan changeset generation
- `contracts/wbs/project.wbs.json`とactive Task Contractによるrepository dogfooding
- WBS status summary
- WJS semantic apply wrapper
- CI-retained reportとmachine-readable Evidence snapshotを含むunit/integration test coverage measurement
- versioned declarative artifact workflow schema、fail-closed DAG validation、read-only `scwbs artifact status/instructions`。workflow guidanceはadvisoryであり、Task authority、Human Gate、required check、Evidence provenanceを緩和できない
- deterministic Spec/Task/WBS inventory、5つのroute outcome、brief/roadmap output、cross-Spec boundary review、provenanceを備えたversioned read-only Discovery routing proposal。route outputはdelivery authorityを変更しない
- absolute-root resolution、repository trust、pinned shared Spec provenance、stale/path/cycle check、repository-local Task/Evidence/CI authorityを備えたversioned read-only Planning Store registry。remote Gitとcredential automationは除外する
- one-Task implementer/checks/fresh-reviewer orchestration、two-round cap付きversioned Phase 2 debugger/remediation receipt、stale resume validation、shell-free adapter invocation、provider capability validation、bounded advisory learned note、local execution cost metric、fail-closed authority/Human Gate boundaryを備えたbounded AI execution runner。PRとmerge automationは除外する
- exact version check、release-manifest subject/digest verification、offline tarball verification、read-only upgrade proposalを備えたfirst-class release lifecycle UX。npm publicationとunattended upgradeはhuman decisionとして残る
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
| Change control | Spec Change workflow enforcement | <!-- scwbs-capability: spec-change-workflow-enforcement status=missing --> Proposal creationとLevel 2 request routingは存在するが、より広いworkflow enforcementが残る |
| Evidence trust | External artifact signatureとindependent CI attestation | `evidence verify-attestation`はbounded GitHub Artifact Attestation verification summaryを記録するが、workflow permission、trust-root adoption、release publicationはHuman-onlyとして残る |
| Evidence diff basis | Independent external artifact signatureとpublish-time promotion policy | `evidence import-ci`はbounded PR readiness artifactを検証し、`evidence verify-attestation`はexact artifact digestとsubject identityを検証する。automatic promotionはscope外である |
| Test quality | Diff-aware assertionとcoverage inspection | Phase 1はchanged test file、added skip/only/todo marker、verified base receiptがある場合のfail-safe line-coverage deltaを記録する。AST assertion countとthreshold gateは意図的にscope外である |
| Review independence | Human review transitionとexternal reviewer promotion | Phase 1はfresh reviewer resultを収集できるが、human-only Review transitionを作成せず、reviewer resultをcompletionへpromoteしない |
| CI integration | Independent attestationとautomatic promotion | trusted `workflow_run` reportingとbounded external verifierがprovenance evidenceを提供する。workflow permission、automatic Approval/Review/merge、unbounded annotationは意図的に除外する |
| WBS collaboration | Distributed WBS support | <!-- scwbs-capability: wbs-distributed-support status=missing --> Full distributed collaborationはread-only semantic merge plannerの外に残る |

## 近い将来のフォローアップ

- Proposal creationとLevel 2 request routingを超えてSpec Change workflow enforcementを拡張する。
- 実行可能な範囲で`testQualityObservation`へAST-based assertion countを拡張する。Phase 1はmanual `testQuality` metadataを置き換えず、test diffとverified coverage summaryを比較する。
- read-only WBS semantic merge planningをdistributed WBS supportへ拡張する。
- patch-retention merge後にread-only inventoryを実行し、記録されたsubject、base、diffHash、changedFilesを再現できるhistorical Evidenceだけをbackfillする。
- `npm run scwbs -- evidence prune --json`でcurrent tracked payload inventoryを確認する。このcommandは意図的にread-onlyであり、archived Task candidateを報告するが、cutoff選択、payload削除、archive upload、Git history rewriteは行わない。
- release workflow permissionとattestation generationは、別途approveされたthreat model、repository-plan review、Human Gateの後にだけ追加する。このTaskは`.github` workflowを変更しない。
