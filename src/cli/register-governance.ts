import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Command } from "commander";
import {
  readSpec,
  readTask,
  runArtifactWorkflowInstructions,
  runArtifactWorkflowStatus,
  runPlanningStoreList,
  runPlanningStoreShow,
  runValidateFeature
} from "../core/contracts.js";
import { resolveFrom, specChangePath, specPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { SpecChangeProposal } from "../core/types.js";
import { runAiBlock, runAiNextTask } from "../commands/ai-queue.js";
import { runAiPacket } from "../commands/ai-packet.js";
import { runAiExecute, runAiRun } from "../commands/ai-run.js";
import { runApprovalDelegationPrepare } from "../commands/approval-delegation.js";
import { runApprovalApprove, runApprovalRequest } from "../commands/approval-request.js";
import { runCompletionApply } from "../commands/completion.js";
import { runEvidenceAnnotate } from "../commands/evidence-annotate.js";
import { runEvidenceCollect, runEvidenceImportCi, runEvidencePrune, runEvidenceRetain, runEvidenceVerifyAttestation } from "../commands/evidence-collect.js";
import { runProfileSet, runProfileShow } from "../commands/profile.js";
import { runRegistryRebuild } from "../commands/registry-rebuild.js";
import {
  runReviewApprove,
  runReviewChangesRequested,
  runReviewClose,
  runReviewRequest,
  runReviewRoute
} from "../commands/review-request.js";
import { parseTestQuality, type CommandContext } from "./command-context.js";
import { runGithubIssueIntake } from "../commands/intake.js";

type SpecChangeNewOptions = {
  id?: string;
  spec: string;
  task: string;
  summary: string;
  rationale: string;
  proposedVersion: string;
  level?: string | number;
  affectedPaths?: string;
  risks?: string;
};

function splitSpecChangeItems(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function runSpecChangeNew(root: string, options: SpecChangeNewOptions): number {
  try {
    const taskResult = readTask(root, options.task);
    if (!taskResult.task) throw new Error(taskResult.issues.map((issue) => issue.message).join("\n"));

    const specRelativePath = specPath(options.spec);
    const specResult = readSpec(root, specRelativePath);
    if (!specResult.spec) throw new Error(specResult.issues.map((issue) => issue.message).join("\n"));

    const level = Number(options.level ?? 1);
    if (![0, 1, 2].includes(level)) throw new Error("Invalid --level; expected 0, 1, or 2");

    const id = options.id ?? `SCP-${taskResult.task.id}-${Date.now().toString(36).toUpperCase()}`;
    const relativePath = specChangePath(id);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath)) throw new Error(`${relativePath} already exists`);

    const affectedPaths = splitSpecChangeItems(options.affectedPaths);
    const risks = splitSpecChangeItems(options.risks);
    const proposal: SpecChangeProposal = {
      id,
      type: "spec-change-proposal",
      status: "proposed",
      targetSpec: specResult.spec.id,
      currentVersion: specResult.spec.version,
      proposedVersion: options.proposedVersion,
      taskId: taskResult.task.id,
      level: level as SpecChangeProposal["level"],
      summary: options.summary,
      rationale: [options.rationale],
      affectedPaths: affectedPaths.length > 0 ? affectedPaths : [specRelativePath],
      approval: { required: level === 2, status: "requested" },
      ...(risks.length > 0 ? { risks } : {})
    };

    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, stringifySimpleYaml(proposal as unknown as Record<string, unknown>), "utf8");
    process.stdout.write(`Created Spec Change Proposal: ${relativePath}\n`);
    process.stdout.write(`Level: ${proposal.level}\n`);
    process.stdout.write(`Approval: ${proposal.approval?.status}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function registerGovernanceCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  program
    .command("intake")
    .description("Read external inputs into bounded discovery candidates")
    .command("github-issue")
    .description("Read a GitHub Issue without granting it authority")
    .argument("<number>", "GitHub Issue number")
    .option("--repository <owner/repo>", "explicit GitHub repository")
    .option("--expected-digest <digest>", "classify the snapshot as stale when the digest differs")
    .option("--json", "output versioned JSON")
    .action((number: string, options) => setExitCode(runGithubIssueIntake(root, number, options)));
  const validate = program.command("validate").description("Validate cross-Task feature completion");
  validate
    .command("feature")
    .description("Validate Requirement to Task to Evidence traceability")
    .requiredOption("--spec <id>", "Spec id")
    .option("--base <ref>", "merge base reference", "origin/main")
    .option("--json", "print a versioned JSON report")
    .action((options) => {
      setExitCode(runValidateFeature(root, options.spec, { baseRef: options.base, json: options.json ?? false }));
    });

  const artifact = program.command("artifact").description("Inspect declarative artifact workflows");
  artifact
    .command("status")
    .description("Show read-only artifact workflow status")
    .option("--workflow <path>", "workflow path", "contracts/workflows/builtin-scwbs-v1.yaml")
    .option("--json", "print a versioned JSON report")
    .action((options) =>
      setExitCode(runArtifactWorkflowStatus(root, options.workflow, { json: options.json ?? false }))
    );
  artifact
    .command("instructions")
    .description("Show read-only artifact guidance")
    .argument("<artifact>", "artifact id")
    .option("--workflow <path>", "workflow path", "contracts/workflows/builtin-scwbs-v1.yaml")
    .option("--json", "print a versioned JSON report")
    .action((artifactId, options) =>
      setExitCode(runArtifactWorkflowInstructions(root, options.workflow, artifactId, { json: options.json ?? false }))
    );

  const store = program.command("store").description("Inspect read-only cross-repository planning stores");
  store
    .command("list")
    .description("List registered planning stores without mutating them")
    .option("--registry <path>", "planning-store registry path", "planning-store.yaml")
    .option("--json", "print a versioned JSON report")
    .action((options) => {
      setExitCode(runPlanningStoreList(root, options.registry, { json: options.json ?? false }));
    });
  store
    .command("show")
    .description("Show pinned shared Specs and trust provenance for a planning store")
    .requiredOption("--store <id>", "planning store id")
    .option("--registry <path>", "planning-store registry path", "planning-store.yaml")
    .option("--json", "print a versioned JSON report")
    .action((options) => {
      setExitCode(runPlanningStoreShow(root, options.registry, options.store, { json: options.json ?? false }));
    });

  const specChange = program.command("spec-change").description("Manage Spec Change Proposals");
  specChange
    .command("new")
    .description("Create a proposed Spec Change Proposal without mutating the target Spec")
    .requiredOption("--spec <id>", "target Spec id")
    .requiredOption("--task <id>", "owning Task id")
    .requiredOption("--summary <text>", "change summary")
    .requiredOption("--rationale <text>", "reason for the proposed change")
    .requiredOption("--proposed-version <version>", "proposed Spec version")
    .option("--id <id>", "proposal id; generated when omitted")
    .option("--level <n>", "change level 0, 1, or 2", "1")
    .option("--affected-paths <paths>", "comma-separated affected paths")
    .option("--risks <items>", "comma-separated risks")
    .action((options) => {
      setExitCode(runSpecChangeNew(root, options));
    });

  const ai = program.command("ai").description("Build AI packets and dry-run task plans");
  ai.command("packet")
    .description("Build AI work packet")
    .option("--task <id>", "task id")
    .option("--relation-depth <n>", "relation depth", parseInt)
    .option("--format <type>", "output format")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      const format: string = options.format ?? "default";
      if (!["default", "compact", "codex", "claude", "cursor"].includes(format)) {
        console.error("Invalid --format");
        setExitCode(2);
        return;
      }
      setExitCode(
        runAiPacket(
          root,
          options.task,
          options.relationDepth ?? 1,
          format as "default" | "compact" | "codex" | "claude" | "cursor"
        )
      );
    });

  ai.command("run")
    .description("Print a dry-run AI task plan")
    .option("--task <id>", "task id")
    .option("--agent <agent>", "agent type")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runAiRun(root, options.task, options.agent));
    });

  ai.command("execute")
    .description("Run one bounded implementer-checks-fresh-reviewer iteration, with optional debugger remediation")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--implementer-command <json>", "JSON command array for the implementer adapter")
    .requiredOption("--reviewer-command <json>", "JSON command array for the fresh reviewer adapter")
    .option("--base <ref>", "base ref for required-check receipts", "origin/main")
    .option("--receipt <path>", "optional local run receipt path")
    .option("--debugger-command <json>", "JSON command array for the fresh debugger adapter; enables Phase 2")
    .option("--resume-receipt <path>", "resume a blocked Phase 2 reviewer rejection after receipt validation")
    .option("--implementer-provider <json>", "JSON provider descriptor for the implementer")
    .option("--reviewer-provider <json>", "JSON provider descriptor for the reviewer")
    .option("--debugger-provider <json>", "JSON provider descriptor for the debugger")
    .option("--learned-note <json>", "bounded advisory note with source Task, HEAD SHA, scope, and note")
    .option("--json", "print the versioned run receipt as JSON")
    .action((options) => {
      setExitCode(runAiExecute(root, {
        taskId: options.task,
        implementerCommand: options.implementerCommand,
        reviewerCommand: options.reviewerCommand,
        baseRef: options.base,
        receiptPath: options.receipt,
        debuggerCommand: options.debuggerCommand,
        resumeReceipt: options.resumeReceipt,
        implementerProvider: options.implementerProvider,
        reviewerProvider: options.reviewerProvider,
        debuggerProvider: options.debuggerProvider,
        learnedNote: options.learnedNote,
        json: options.json ?? false
      }));
    });

  ai.command("block")
    .description("AI: block a task")
    .option("--task <id>", "task id")
    .option("--reason <text>", "block reason")
    .option("--spec-change", "spec change flag")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      if (!options.reason) {
        console.error("Missing --reason <reason>");
        setExitCode(2);
        return;
      }
      setExitCode(runAiBlock(root, options.task, options.reason, { specChange: options.specChange ?? false }));
    });

  ai.command("next-task")
    .description("Show next AI task")
    .action(() => {
      setExitCode(runAiNextTask(root));
    });

  const approval = program.command("approval").description("Manage task approval requests and delegated policy preparation");
  approval
    .command("request")
    .description("Request task approval")
    .argument("[note...]")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--note <text>", "approval note")
    .option("--force", "force request")
    .option("--json", "output a bounded versioned JSON summary")
    .action((noteParts: string[], options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      const note = noteParts.length > 0 ? [options.note, ...noteParts].filter(Boolean).join(" ") : options.note;
      setExitCode(
        runApprovalRequest(root, options.task, {
          pullRequest: options.pullRequest,
          note,
          force: options.force ?? false,
          json: options.json ?? false
        })
      );
    });

  approval
    .command("approve")
    .description("Approve a task")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--reason <text>", "approval reason")
    .option("--actor <text>", "approval actor")
    .option("--scope <scope>", "delegated approval scope human-gate|post-finish")
    .option("--force", "force approval")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runApprovalApprove(root, options.task, {
          pullRequest: options.pullRequest,
          reason: options.reason,
          actor: options.actor,
          scope: options.scope,
          force: options.force ?? false
        })
      );
    });

  const approvalDelegation = approval.command("delegation");
  approvalDelegation
    .command("prepare")
    .description("Prepare a secret-free delegated approval policy patch before a Task Contract creation commit")
    .option("--task <id>", "task id")
    .requiredOption("--scopes <scopes>", "comma-separated scopes: human-gate,post-finish")
    .requiredOption("--expires-at <utc>", "future UTC expiry")
    .requiredOption("--source <source>", "delegation policy source")
    .requiredOption("--reason <reason>", "delegation reason")
    .requiredOption("--delegated-by <principal>", "delegating principal")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runApprovalDelegationPrepare(root, options.task, options));
    });

  const completion = program.command("completion").description("Apply completion changes through SC-WBS");
  completion
    .command("apply")
    .description("Apply completion")
    .option("--tasks <ids>", "task ids (comma separated)")
    .option("--task <id>", "completion task id")
    .option("--reason <text>", "completion reason")
    .option("--apply", "apply changes")
    .option("--allow-root", "allow root changes")
    .action((options) => {
      setExitCode(
        runCompletionApply(root, options.tasks, options.task, {
          reason: options.reason,
          apply: options.apply ?? false,
          allowRoot: options.allowRoot ?? false
        })
      );
    });

  const evidence = program.command("evidence").description("Collect and maintain Task Evidence");
  evidence
    .command("collect")
    .description("Collect evidence for a task")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--pull-request <id>", "pull request id")
    .option("--ci-receipt <path>", "verified GitHub CI receipt JSON")
    .option("--coverage-receipt <path>", "verified CI coverage receipt JSON")
    .option("--force", "force collection")
    .option("--test-assertions-added <bool>", "test assertions added")
    .option("--tests-disabled <bool>", "tests disabled")
    .option("--coverage-decreased <bool>", "coverage decreased")
    .option("--test-quality-note <text>", "test quality note")
    .option("--rerun-checks", "rerun required checks even when cached results are valid")
    .option("--json", "print a versioned JSON summary")
    .option("--verbose", "print the summary and full Evidence YAML")
    .option("--output <target>", "print full Evidence YAML; target must be -")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runEvidenceCollect(root, options.task, {
          force: options.force ?? false,
          baseRef: options.base,
          pullRequest: options.pullRequest,
          ciReceipt: options.ciReceipt,
          coverageReceipt: options.coverageReceipt,
          testQuality: parseTestQuality(options),
          rerunChecks: options.rerunChecks ?? false,
          json: options.json ?? false,
          verbose: options.verbose ?? false,
          output: options.output
        })
      );
    });

  evidence
    .command("import-ci")
    .description("Import provenance-verified CI Evidence from a readiness artifact")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--readiness <path>", "PR readiness artifact JSON")
    .requiredOption("--ci-receipt <path>", "verified CI receipt JSON")
    .option("--coverage-receipt <path>", "verified CI coverage receipt JSON")
    .action((options) => {
      setExitCode(runEvidenceImportCi(root, options.task, {
        readiness: options.readiness,
        ciReceipt: options.ciReceipt,
        coverageReceipt: options.coverageReceipt
      }));
    });

  evidence
    .command("verify-attestation")
    .description("Verify a release or CI artifact attestation without trusting local provenance alone")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--artifact <path>", "artifact path")
    .option("--repository <owner/repo>", "expected GitHub repository")
    .option("--signer-workflow <path>", "expected signer workflow path")
    .option("--predicate-type <uri>", "expected predicate type")
    .option("--source-ref <ref>", "expected source ref")
    .option("--source-commit <commit>", "expected source commit")
    .option("--bundle <path>", "offline attestation bundle")
    .option("--custom-trusted-root <path>", "offline trusted root; never adopted implicitly")
    .option("--json", "print bounded JSON result")
    .action((options) => {
      setExitCode(runEvidenceVerifyAttestation(root, options.task, {
        artifact: options.artifact,
        repository: options.repository,
        signerWorkflow: options.signerWorkflow,
        predicateType: options.predicateType,
        sourceRef: options.sourceRef,
        sourceCommit: options.sourceCommit,
        bundle: options.bundle,
        customTrustedRoot: options.customTrustedRoot,
        json: options.json ?? false
      }));
    });

  evidence
    .command("annotate")
    .description("Update Evidence metadata without changing subject provenance or checks")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--test-assertions-added <bool>", "test assertions added")
    .option("--tests-disabled <bool>", "tests disabled")
    .option("--coverage-decreased <bool>", "coverage decreased")
    .option("--test-quality-note <text>", "test quality note")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runEvidenceAnnotate(root, options.task, {
          pullRequest: options.pullRequest,
          testQuality: parseTestQuality(options)
        })
      );
    });

  evidence
    .command("retain")
    .description("Retain an existing Evidence subject as a tracked patch payload")
    .option("--task <id>", "task id")
    .option("--fetch-pr-head", "fetch the recorded GitHub pull request head when the subject is unavailable")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runEvidenceRetain(root, options.task, { fetchPrHead: options.fetchPrHead ?? false }));
    });

  evidence
    .command("prune")
    .description("Show a read-only Evidence retention inventory and prune plan")
    .option("--json", "print a versioned JSON summary")
    .option("--apply", "reserved for a separately approved retention Task; always fails closed here")
    .action((options) => {
      setExitCode(runEvidencePrune(root, { json: options.json ?? false, apply: options.apply ?? false }));
    });

  const registry = program.command("registry").description("Validate and rebuild the contract registry");
  registry
    .command("rebuild")
    .description("Rebuild registry")
    .option("--check", "check only")
    .option("--force", "force rebuild")
    .option("--quiet", "suppress successful output")
    .option("--json", "print a versioned JSON summary")
    .option("--verbose", "print the summary and full registry YAML")
    .option("--output <target>", "print full registry YAML; target must be -")
    .action((options) => {
      setExitCode(
        runRegistryRebuild(root, {
          check: options.check ?? false,
          force: options.force ?? false,
          quiet: options.quiet ?? false,
          json: options.json ?? false,
          verbose: options.verbose ?? false,
          output: options.output
        })
      );
    });

  const profile = program.command("profile").description("Show or change the SC-WBS profile");
  profile
    .command("show")
    .description("Show profile")
    .action(() => {
      setExitCode(runProfileShow(root));
    });

  profile
    .command("set")
    .description("Set profile through a WBS changeset")
    .argument("<profile>", "profile name")
    .action((profileName: string) => {
      if (!profileName) {
        console.error("Missing profile");
        setExitCode(2);
        return;
      }
      setExitCode(runProfileSet(root, profileName));
    });

  const review = program.command("review").description("Request and route Task reviews");
  review
    .command("request")
    .description("Request a review")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--force", "force request")
    .option("--json", "print a versioned JSON summary")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runReviewRequest(root, options.task, {
          pullRequest: options.pullRequest,
          force: options.force ?? false,
          json: options.json ?? false
        })
      );
    });

  review
    .command("route")
    .description("Route a review")
    .option("--task <id>", "task id")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runReviewRoute(root, options.task));
    });

  review
    .command("approve")
    .description("Approve a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--findings <text>", "review findings")
    .option("--force", "force approve")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runReviewApprove(root, options.task, {
          reviewedBy: options.actor,
          findings: options.findings,
          force: options.force ?? false
        })
      );
    });

  review
    .command("changes-requested")
    .description("Request changes for a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--findings <text>", "review findings")
    .option("--force", "force changes-requested")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(
        runReviewChangesRequested(root, options.task, {
          reviewedBy: options.actor,
          findings: options.findings,
          force: options.force ?? false
        })
      );
    });

  review
    .command("close")
    .description("Close a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--force", "force close")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runReviewClose(root, options.task, { reviewedBy: options.actor, force: options.force ?? false }));
    });
}
