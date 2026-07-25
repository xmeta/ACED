#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runAiBlock, runAiNextTask, runHumanBlockResolve } from "./commands/ai-queue.js";
import { buildTinyPacket, runAiPacket, runCodeContextManifest } from "./commands/ai-packet.js";
import { runAiRun } from "./commands/ai-run.js";
import { runApprovalApprove, runApprovalRequest } from "./commands/approval-request.js";
import { runApprovalDelegationPrepare } from "./commands/approval-delegation.js";
import { runCheck } from "./commands/check.js";
import { runDocsCheck } from "./commands/docs-check.js";
import { runCheckDiff } from "./commands/check-diff.js";
import { runCiPlan } from "./commands/ci-plan.js";
import { runChecksRun } from "./commands/checks-run.js";
import { runCompletionApply } from "./commands/completion.js";
import { runDoctor } from "./commands/doctor.js";
import { runEvidenceCollect } from "./commands/evidence-collect.js";
import { runEvidenceAnnotate } from "./commands/evidence-annotate.js";
import { runFinish } from "./commands/finish.js";
import { runFix } from "./commands/fix.js";
import { runHealth } from "./commands/health.js";
import { runInit } from "./commands/init.js";
import { runLiteTask, runPromote } from "./commands/lite.js";
import { runMetricsGovernance } from "./commands/metrics.js";
import { runNext } from "./commands/next.js";
import { runPlan } from "./commands/plan.js";
import { runProfileSet, runProfileShow } from "./commands/profile.js";
import { runRegistryRebuild } from "./commands/registry-rebuild.js";
import { runReviewApprove, runReviewChangesRequested, runReviewClose, runReviewRequest, runReviewRoute } from "./commands/review-request.js";
import { runReviewQueue } from "./commands/review-queue.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runTaskGenerate } from "./commands/task-generate.js";
import { runTaskArchive, runTaskIndexRebuild } from "./commands/task-index.js";
import { runTaskLock } from "./commands/task-lock.js";
import { runTaskNew } from "./commands/task-new.js";
import { runTaskRefresh } from "./commands/task-refresh.js";
import { runTrace } from "./commands/trace.js";
import { runServe, runUi } from "./commands/ui.js";
import { runWbsApply, runWbsCandidates, runWbsValidate, runWbsVerifyChangesets } from "./commands/wbs.js";
import { isValidTaskId } from "./core/paths.js";
import type { Evidence } from "./core/types.js";

function parseBool(val: unknown): boolean | undefined {
  if (val === undefined || val === "") return undefined;
  if (val === true || val === "true") return true;
  if (val === false || val === "false") return false;
  return undefined;
}

function parseTestQuality(opts: Record<string, unknown>): Evidence["testQuality"] | undefined {
  const assertionsAdded = parseBool(opts.testAssertionsAdded);
  const testsDisabled = parseBool(opts.testsDisabled);
  const coverageDecreased = parseBool(opts.coverageDecreased);
  const note = opts.testQualityNote as string | undefined;
  if (assertionsAdded === undefined && testsDisabled === undefined && coverageDecreased === undefined && note === undefined) {
    return undefined;
  }
  return {
    ...(assertionsAdded !== undefined ? { assertionsAdded } : {}),
    ...(testsDisabled !== undefined ? { testsDisabled } : {}),
    ...(coverageDecreased !== undefined ? { coverageDecreased } : {}),
    ...(note ? { notes: [note] } : {})
  };
}

export function main(argv = process.argv.slice(2), root = process.cwd()): number {
  let exitCode = 0;
  const taskOptionIndex = argv.findIndex((argument) => argument === "--task" || argument.startsWith("--task="));
  if (taskOptionIndex >= 0) {
    const option = argv[taskOptionIndex] ?? "";
    const taskId = option === "--task" ? argv[taskOptionIndex + 1] : option.slice("--task=".length);
    if (taskId !== undefined && !isValidTaskId(taskId)) {
      if (argv.includes("--json")) {
        console.error(JSON.stringify({
          version: "scwbs.error.v1",
          status: "error",
          code: "task.id.invalid",
          message: "Invalid task id"
        }));
      } else {
        console.error("ERROR task.id.invalid: Invalid task id");
      }
      return 2;
    }
  }

  const program = new Command();
  program
    .name("scwbs")
    .description("SC-WBS CLI")
    .version("0.1.0")
    .exitOverride()
    .showHelpAfterError(true)
    .showSuggestionAfterError(true)
    .allowExcessArguments(true);

  program
    .command("init")
    .description("Initialize a new project")
    .option("--profile <profile>", "profile lean|standard|strict")
    .option("--agent <agent>", "agent type")
    .option("--lang <lang>", "language ja|en")
    .action((opts) => { exitCode = runInit(root, opts); });

  program
    .command("check")
    .description("Check repository contracts")
    .option("--json", "output as JSON")
    .action((opts) => { exitCode = runCheck(root, { json: opts.json ?? false }); });

  const docs = program.command("docs").description("Validate documentation lifecycle metadata");
  docs
    .command("check")
    .description("Check documentation status, ownership, successors, and CLI applicability")
    .option("--json", "output a versioned JSON report")
    .action((opts) => { exitCode = runDocsCheck(root, { json: opts.json ?? false }); });

  const ci = program.command("ci");
  ci
    .command("plan")
    .description("Plan full or provenance-verified metadata CI and report a read-only task execution classification")
    .option("--task <id>", "task id")
    .option("--branch <name>", "branchName used to discover the task")
    .option("--base <ref>", "base reference")
    .option("--json", "output a versioned JSON plan")
    .action((opts) => {
      exitCode = runCiPlan(root, {
        taskId: opts.task,
        branch: opts.branch,
        baseRef: opts.base,
        json: opts.json ?? false
      });
    });

  const checks = program.command("checks");
  checks
    .command("run")
    .description("Run required checks and write a provenance-bound receipt")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--rerun-checks", "rerun required checks even when a receipt is valid")
    .option("--json", "output a versioned JSON summary")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runChecksRun(root, opts.task, {
        baseRef: opts.base,
        rerunChecks: opts.rerunChecks ?? false,
        json: opts.json ?? false
      });
    });

  program
    .command("fix")
    .description("Fix auto-fixable issues")
    .action(() => { exitCode = runFix(root); });

  program
    .command("doctor")
    .description("Diagnose and optionally fix repository issues")
    .option("--fix", "apply auto-fixes")
    .option("--json", "output as JSON")
    .action((opts) => { exitCode = runDoctor(root, { fix: opts.fix ?? false, json: opts.json ?? false }); });

  program
    .command("health")
    .description("Check repository health")
    .option("--json", "output a versioned JSON report")
    .option("--verbose", "show every health issue")
    .option("--governance-cost", "include warning-only governance cost budget status")
    .action((opts) => { exitCode = runHealth(root, { json: opts.json ?? false, verbose: opts.verbose ?? false, governanceCost: opts.governanceCost ?? false }); });

  const metrics = program.command("metrics");
  metrics
    .command("governance")
    .description("Measure governance cost without writing artifacts")
    .option("--json", "output a versioned JSON summary")
    .action((opts) => { exitCode = runMetricsGovernance(root, { json: opts.json ?? false }); });

  program
    .command("status")
    .description("Show repository status")
    .option("--json", "output a versioned JSON report")
    .option("--strict", "fail when completed Task trust is not fully verified")
    .action((opts) => { exitCode = runStatus(root, { json: opts.json ?? false, strict: opts.strict ?? false }); });

  program
    .command("review-queue")
    .description("Show review queue")
    .option("--verbose", "show every candidate with full review details")
    .option("--json", "print a versioned JSON summary")
    .option("--limit <count>", "limit candidates in summary or JSON output")
    .action((opts) => {
      exitCode = runReviewQueue(root, {
        verbose: opts.verbose ?? false,
        json: opts.json ?? false,
        limit: opts.limit === undefined ? undefined : Number(opts.limit)
      });
    });

  program
    .command("next")
    .description("Show next suggested action")
    .action(() => { exitCode = runNext(root); });

  program
    .command("ui")
    .description("Start web UI")
    .action(() => { exitCode = runUi(root); });

  program
    .command("serve")
    .description("Start API server")
    .action(() => { exitCode = runServe(); });

  program
    .command("finish")
    .description("Finish a task")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--pr <number>", "pull request number")
    .option("--pull-request <number>", "pull request number (legacy)")
    .option("--rerun-checks", "rerun required checks even when cached results are valid")
    .option("--preflight", "validate finish readiness without running checks or writing files")
    .option("--test-assertions-added <bool>", "test assertions added")
    .option("--tests-disabled <bool>", "tests disabled")
    .option("--coverage-decreased <bool>", "coverage decreased")
    .option("--test-quality-note <text>", "test quality note")
    .option("--json", "output as JSON")
    .action((opts) => {
      exitCode = runFinish(root, {
        taskId: opts.task,
        baseRef: opts.base,
        pullRequest: opts.pr ?? opts.pullRequest,
        force: true,
        json: opts.json ?? false,
        rerunChecks: opts.rerunChecks ?? false,
        preflight: opts.preflight ?? false,
        testQuality: parseTestQuality(opts)
      });
    });

  program
    .command("packet")
    .description("Build a task packet")
    .option("--task <id>", "task id")
    .option("--tiny", "tiny packet (default)")
    .option("--standard", "standard packet")
    .option("--full", "full packet")
    .option("--deep", "deep packet (legacy)")
    .option("--normal", "normal packet (legacy)")
    .option("--context-json", "output a source-free read-only code context manifest")
    .option("--context-max-files <n>", "maximum selected context files", parseInt)
    .option("--context-max-bytes <n>", "maximum selected context bytes", parseInt)
    .option("--context-include-noncurrent-docs", "include proposal, deprecated, and superseded docs")
    .option("--relation-depth <n>", "relation depth", parseInt)
    .action((opts) => {
      const taskId = opts.task;
      if (!taskId) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      if (opts.contextJson) {
        exitCode = runCodeContextManifest(root, taskId, {
          maxFiles: opts.contextMaxFiles,
          maxBytes: opts.contextMaxBytes,
          includeNonCurrentDocs: opts.contextIncludeNoncurrentDocs ?? false
        });
      } else if (opts.full || opts.deep) {
        exitCode = runAiPacket(root, taskId, opts.relationDepth ?? 1, "default");
      } else if (opts.standard || opts.normal) {
        exitCode = runAiPacket(root, taskId, opts.relationDepth ?? 0, "default");
      } else {
        try {
          process.stdout.write(buildTinyPacket(root, taskId));
          exitCode = 0;
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          exitCode = 1;
        }
      }
    });

  program
    .command("block")
    .description("Block a task, or resolve an active Block with the human-only `block resolve` form")
    .argument("[reason...]", "block reason")
    .option("--task <id>", "task id")
    .option("--reason <text>", "block reason (alternative)")
    .option("--spec-change", "spec change flag")
    .action((reasonParts: string[], opts) => {
      const taskId = opts.task;
      if (!taskId) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      const resolveRequested = reasonParts.length === 1 && reasonParts[0] === "resolve" && typeof opts.reason === "string";
      const reason = (resolveRequested ? reasonParts.slice(1) : reasonParts).join(" ").trim() || (opts.reason as string) || "";
      if (!reason) {
        console.error(resolveRequested ? "Missing resolution reason" : "Missing block reason");
        exitCode = 2;
        return;
      }
      exitCode = resolveRequested
        ? runHumanBlockResolve(root, taskId, reason)
        : runAiBlock(root, taskId, reason, { specChange: opts.specChange ?? false });
    });

  program
    .command("request-approval")
    .description("Request task approval")
    .option("--task <id>", "task id")
    .option("--pr <number>", "pull request number")
    .option("--pull-request <number>", "pull request number (legacy)")
    .option("--note <text>", "approval note")
    .option("--force", "force request")
    .action((opts) => {
      const taskId = opts.task;
      if (!taskId) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runApprovalRequest(root, taskId, {
        pullRequest: opts.pr ?? opts.pullRequest,
        note: opts.note,
        force: opts.force ?? false
      });
    });

  program
    .command("approve")
    .description("Approve a task")
    .option("--task <id>", "task id")
    .option("--pr <number>", "pull request number")
    .option("--pull-request <number>", "pull request number (legacy)")
    .option("--reason <text>", "approval reason")
    .option("--actor <text>", "approval actor")
    .option("--scope <scope>", "delegated approval scope human-gate|post-finish")
    .option("--force", "force approval")
    .action((opts) => {
      const taskId = opts.task;
      if (!taskId) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runApprovalApprove(root, taskId, {
        pullRequest: opts.pr ?? opts.pullRequest,
        reason: opts.reason,
        actor: opts.actor,
        scope: opts.scope,
        force: opts.force ?? false
      });
    });

  program
    .command("start")
    .description("Start a task with a goal")
    .argument("<goal...>", "task goal text")
    .action((goalParts: string[]) => {
      const goal = goalParts.join(" ").trim();
      if (!goal) {
        console.error("Missing goal text");
        exitCode = 2;
        return;
      }
      exitCode = runStart(root, goal);
    });

  program
    .command("plan")
    .description("Plan from a spec")
    .option("--spec <id>", "spec id")
    .action((opts) => {
      if (!opts.spec) {
        console.error("Missing --spec <spec-id>");
        exitCode = 2;
        return;
      }
      exitCode = runPlan(root, opts.spec);
    });

  program
    .command("promote")
    .description("Promote a lite task")
    .option("--task <id>", "task id")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runPromote(root, opts.task);
    });

  program
    .command("trace")
    .description("Trace task dependencies")
    .option("--task <id>", "task id")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runTrace(root, opts.task);
    });

  program
    .command("check-diff")
    .description("Check diff against task contract")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--json", "output as JSON")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runCheckDiff(root, opts.task, { baseRef: opts.base, json: opts.json ?? false });
    });

  const ai = program.command("ai");
  ai
    .command("packet")
    .description("Build AI work packet")
    .option("--task <id>", "task id")
    .option("--relation-depth <n>", "relation depth", parseInt)
    .option("--format <type>", "output format")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      const format: string = opts.format ?? "default";
      if (!["default", "compact", "codex", "claude", "cursor"].includes(format)) {
        console.error("Invalid --format");
        exitCode = 2;
        return;
      }
      exitCode = runAiPacket(root, opts.task, opts.relationDepth ?? 1, format as "default" | "compact" | "codex" | "claude" | "cursor");
    });

  ai
    .command("run")
    .description("Run AI on a task")
    .option("--task <id>", "task id")
    .option("--agent <agent>", "agent type")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runAiRun(root, opts.task, opts.agent);
    });

  ai
    .command("block")
    .description("AI: block a task")
    .option("--task <id>", "task id")
    .option("--reason <text>", "block reason")
    .option("--spec-change", "spec change flag")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      if (!opts.reason) {
        console.error("Missing --reason <reason>");
        exitCode = 2;
        return;
      }
      exitCode = runAiBlock(root, opts.task, opts.reason, { specChange: opts.specChange ?? false });
    });

  ai
    .command("next-task")
    .description("Show next AI task")
    .action(() => { exitCode = runAiNextTask(root); });

  const approval = program.command("approval");
  approval
    .command("request")
    .description("Request task approval")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--note <text>", "approval note")
    .option("--force", "force request")
    .action(function (this: Command, opts) {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      const trailing = (this.args as string[]).filter((a) => !a.startsWith("-"));
      const note = trailing.length > 0 ? [opts.note, ...trailing].filter(Boolean).join(" ") : opts.note;
      exitCode = runApprovalRequest(root, opts.task, {
        pullRequest: opts.pullRequest,
        note,
        force: opts.force ?? false
      });
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
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runApprovalApprove(root, opts.task, {
        pullRequest: opts.pullRequest,
        reason: opts.reason,
        actor: opts.actor,
        scope: opts.scope,
        force: opts.force ?? false
      });
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
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runApprovalDelegationPrepare(root, opts.task, opts);
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
    .action((opts) => {
      exitCode = runCompletionApply(root, opts.tasks, opts.task, {
        reason: opts.reason,
        apply: opts.apply ?? false,
        allowRoot: opts.allowRoot ?? false
      });
    });

  const evidence = program.command("evidence");
  evidence
    .command("collect")
    .description("Collect evidence for a task")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--pull-request <id>", "pull request id")
    .option("--ci-receipt <path>", "verified GitHub CI receipt JSON")
    .option("--force", "force collection")
    .option("--test-assertions-added <bool>", "test assertions added")
    .option("--tests-disabled <bool>", "tests disabled")
    .option("--coverage-decreased <bool>", "coverage decreased")
    .option("--test-quality-note <text>", "test quality note")
    .option("--rerun-checks", "rerun required checks even when cached results are valid")
    .option("--json", "print a versioned JSON summary")
    .option("--verbose", "print the summary and full Evidence YAML")
    .option("--output <target>", "print full Evidence YAML; target must be -")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runEvidenceCollect(root, opts.task, {
        force: opts.force ?? false,
        baseRef: opts.base,
        pullRequest: opts.pullRequest,
        ciReceipt: opts.ciReceipt,
        testQuality: parseTestQuality(opts),
        rerunChecks: opts.rerunChecks ?? false,
        json: opts.json ?? false,
        verbose: opts.verbose ?? false,
        output: opts.output
      });
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
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runEvidenceAnnotate(root, opts.task, {
        pullRequest: opts.pullRequest,
        testQuality: parseTestQuality(opts)
      });
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
    .action((opts) => {
      exitCode = runRegistryRebuild(root, {
        check: opts.check ?? false,
        force: opts.force ?? false,
        quiet: opts.quiet ?? false,
        json: opts.json ?? false,
        verbose: opts.verbose ?? false,
        output: opts.output
      });
    });

  const profile = program.command("profile");
  profile
    .command("show")
    .description("Show profile")
    .action(() => { exitCode = runProfileShow(root); });

  profile
    .command("set")
    .description("Set profile")
    .argument("<profile>", "profile name")
    .action((profileName: string) => {
      if (!profileName) {
        console.error("Missing profile");
        exitCode = 2;
        return;
      }
      exitCode = runProfileSet(root, profileName);
    });

  const review = program.command("review");
  review
    .command("request")
    .description("Request a review")
    .option("--task <id>", "task id")
    .option("--pull-request <id>", "pull request id")
    .option("--force", "force request")
    .option("--json", "print a versioned JSON summary")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runReviewRequest(root, opts.task, {
        pullRequest: opts.pullRequest,
        force: opts.force ?? false,
        json: opts.json ?? false
      });
    });

  review
    .command("route")
    .description("Route a review")
    .option("--task <id>", "task id")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runReviewRoute(root, opts.task);
    });

  review
    .command("approve")
    .description("Approve a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--findings <text>", "review findings")
    .option("--force", "force approve")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runReviewApprove(root, opts.task, { reviewedBy: opts.actor, findings: opts.findings, force: opts.force ?? false });
    });

  review
    .command("changes-requested")
    .description("Request changes for a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--findings <text>", "review findings")
    .option("--force", "force changes-requested")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runReviewChangesRequested(root, opts.task, { reviewedBy: opts.actor, findings: opts.findings, force: opts.force ?? false });
    });

  review
    .command("close")
    .description("Close a review")
    .option("--task <id>", "task id")
    .option("--actor <text>", "review actor (must be human)")
    .option("--force", "force close")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runReviewClose(root, opts.task, { reviewedBy: opts.actor, force: opts.force ?? false });
    });

  const lite = program.command("lite");
  lite
    .command("task")
    .description("Create a lite task")
    .argument("[title...]", "task title")
    .action((titleParts: string[]) => {
      const title = titleParts.join(" ").trim();
      if (!title) {
        console.error("Missing lite task title");
        exitCode = 2;
        return;
      }
      exitCode = runLiteTask(root, title);
    });

  const task = program.command("task");
  task
    .command("generate")
    .description("Generate a task")
    .option("--node <id>", "WBS node id")
    .option("--task <id>", "task id")
    .option("--force", "force generation")
    .action((opts) => {
      if (!opts.node) {
        console.error("Missing --node <node-id>");
        exitCode = 2;
        return;
      }
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runTaskGenerate(root, opts.node, opts.task, { force: opts.force ?? false });
    });

  task
    .command("new")
    .description("Create a new task contract")
    .argument("[title...]", "task title")
    .option("--paths <paths>", "allowed paths (comma separated)")
    .option("--forbid <paths>", "forbidden paths (comma separated)")
    .option("--gate <paths>", "human gate paths (comma separated)")
    .option("--stop <reasons>", "stop reasons (comma separated)")
    .option("--no-stop-conditions", "explicitly acknowledge an empty stop condition list")
    .option("--checks <checks>", "required checks (comma separated)")
    .option("--wbs-node <id>", "WBS node id")
    .action((titleParts: string[], opts) => {
      const title = titleParts.join(" ").trim();
      exitCode = runTaskNew(root, title, {
        paths: opts.paths,
        forbid: opts.forbid,
        gate: opts.gate,
        stop: opts.stop,
        noStopConditions: opts.noStopConditions,
        checks: opts.checks,
        wbsNode: opts.wbsNode
      });
    });

  task
    .command("lock")
    .description("Lock a task")
    .option("--task <id>", "task id")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runTaskLock(root, opts.task);
    });

  const taskIndex = task.command("index").description("Manage the Task Contract lifecycle index");
  taskIndex
    .command("rebuild")
    .description("Check or rebuild contracts/tasks/index.yaml")
    .option("--check", "check index consistency without writing")
    .option("--force", "rebuild the index and synchronize the registry")
    .option("--json", "print bounded JSON summary")
    .action((opts) => {
      exitCode = runTaskIndexRebuild(root, {
        check: opts.check ?? false,
        force: opts.force ?? false,
        json: opts.json ?? false
      });
    });

  task
    .command("archive")
    .description("Exclude a terminal Task from default active scans while retaining its records")
    .requiredOption("--task <id>", "task id")
    .option("--json", "print JSON")
    .action((opts) => {
      exitCode = runTaskArchive(root, opts.task, { json: opts.json ?? false });
    });

  task
    .command("refresh")
    .description("Refresh a task")
    .option("--task <id>", "task id")
    .option("--affected", "preview Task Contracts affected by current WBS or Spec changes")
    .option("--all", "preview or refresh every Task Contract")
    .option("--apply", "apply changes")
    .action((opts) => {
      const selectors = [Boolean(opts.task), Boolean(opts.affected), Boolean(opts.all)].filter(Boolean).length;
      if (selectors !== 1) {
        console.error("Specify exactly one of --task <task-id>, --affected, or --all");
        exitCode = 2;
        return;
      }
      exitCode = runTaskRefresh(root, opts.task, { apply: opts.apply ?? false, affected: opts.affected ?? false, all: opts.all ?? false });
    });

  const wbs = program.command("wbs");
  wbs
    .command("validate")
    .description("Validate WBS")
    .action(() => { exitCode = runWbsValidate(root); });

  wbs
    .command("candidates")
    .description("Show WBS candidates")
    .action(() => { exitCode = runWbsCandidates(root); });

  wbs
    .command("verify-changesets")
    .description("Verify WBS changesets")
    .option("--base <path>", "base wbs.json path")
    .option("--head <path>", "head wbs.json path")
    .option("--changeset <path>", "changeset file path", (val: string, prev: string[]) => prev.concat(val), [] as string[])
    .action((opts) => {
      exitCode = runWbsVerifyChangesets(root, {
        base: opts.base,
        head: opts.head,
        changeSets: opts.changeset ?? []
      });
    });

  wbs
    .command("apply")
    .description("Apply a WBS changeset")
    .argument("<change-set>", "changeset json file")
    .option("--force", "force apply")
    .option("--output <file>", "output file")
    .option("-o <file>", "output file (short)")
    .action((changeSet: string, opts) => {
      if (!changeSet) {
        console.error("Missing change-set.json");
        exitCode = 2;
        return;
      }
      exitCode = runWbsApply(root, changeSet, {
        force: opts.force ?? false,
        output: opts.output ?? opts.O
      });
    });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    program.parse(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    return 1;
  }

  return exitCode;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const exitCode = main();
  process.exit(exitCode);
}
