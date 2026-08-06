import { type Command } from "commander";
import { runAiBlock, runAiNextTask } from "../commands/ai-queue.js";
import { runAiPacket } from "../commands/ai-packet.js";
import { runAiRun } from "../commands/ai-run.js";
import { runApprovalDelegationPrepare } from "../commands/approval-delegation.js";
import { runApprovalApprove, runApprovalRequest } from "../commands/approval-request.js";
import { runCompletionApply } from "../commands/completion.js";
import { runEvidenceAnnotate } from "../commands/evidence-annotate.js";
import { runEvidenceCollect, runEvidencePrune, runEvidenceRetain } from "../commands/evidence-collect.js";
import { runProfileSet, runProfileShow } from "../commands/profile.js";
import { runRegistryRebuild } from "../commands/registry-rebuild.js";
import { runSpecChangeNew } from "../commands/spec-change-new.js";
import {
  runReviewApprove,
  runReviewChangesRequested,
  runReviewClose,
  runReviewRequest,
  runReviewRoute
} from "../commands/review-request.js";
import { parseTestQuality, type CommandContext } from "./command-context.js";

export function registerGovernanceCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
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

  const ai = program.command("ai");
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

  const approval = program.command("approval");
  approval
    .command("request")
    .description("Request task approval")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--note <text>", "approval note")
    .option("--force", "force request")
    .action(function (this: Command, options) {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      const trailing = (this.args as string[]).filter((argument) => !argument.startsWith("-"));
      const note = trailing.length > 0 ? [options.note, ...trailing].filter(Boolean).join(" ") : options.note;
      setExitCode(
        runApprovalRequest(root, options.task, {
          pullRequest: options.pullRequest,
          note,
          force: options.force ?? false
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

  const completion = program.command("completion");
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

  const evidence = program.command("evidence");
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

  const registry = program.command("registry");
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

  const profile = program.command("profile");
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

  const review = program.command("review");
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
