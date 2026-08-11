#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAiBlock, runHumanBlockResolve } from "./commands/ai-queue.js";
import { buildTinyPacket, runAiPacket, runCodeContextManifest } from "./commands/ai-packet.js";
import { runApprovalApprove, runApprovalRequest } from "./commands/approval-request.js";
import { runCheck } from "./commands/check.js";
import { runDocsCheck } from "./commands/docs-check.js";
import { buildStatusJsonOutput } from "./commands/status.js";
import { runCheckDiff } from "./commands/check-diff.js";
import { runCiPlan } from "./commands/ci-plan.js";
import { runChecksRun } from "./commands/checks-run.js";
import { runDoctor } from "./commands/doctor.js";
import { runFinish } from "./commands/finish.js";
import { runFix } from "./commands/fix.js";
import { runHealth } from "./commands/health.js";
import { runAgentAdd, runAgentDoctor, runAgentInspect, runAgentList, runAgentRemove, runAgentSetPrimary, runAgentUpdate, runInit } from "./commands/init.js";
import { runPromote } from "./commands/lite.js";
import { runMerge } from "./commands/merge.js";
import { runMetricsGovernance } from "./commands/metrics.js";
import { runNext } from "./commands/next.js";
import { runPlan } from "./commands/plan.js";
import { runPackInfo, runPackInstall, runPackInspect, runPackList, runPackRemove, runPackSearch, runPackUpdate } from "./commands/pack.js";
import { runReviewQueue } from "./commands/review-queue.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runTrace } from "./commands/trace.js";
import { runServe, runUi } from "./commands/ui.js";
import { runUpgrade, runVersion, runVersionCheck } from "./commands/version.js";
import { runMcpStdio } from "./commands/mcp.js";
import { runIndexRebuild, runIndexStatus, runIndexVerify } from "./commands/local-index.js";
import { runQuery } from "./commands/query.js";
import { runRiskAccept, runRiskAdd, runRiskList, runRiskShow, runRiskUpdate } from "./commands/risk.js";
import { parseTestQuality, type CommandContext } from "./cli/command-context.js";
import { registerDiscoveryCommands } from "./cli/register-discovery.js";
import { registerGovernanceCommands } from "./cli/register-governance.js";
import { registerProjectCommands } from "./cli/register-project.js";
import { registerTaskCommands } from "./cli/register-task.js";
import { registerWbsCommands } from "./cli/register-wbs.js";
import { isValidTaskId } from "./core/paths.js";
import { listActiveTasks, listSpecs, readApproval, readRegistry } from "./core/contracts.js";
import { resolveFrom } from "./core/paths.js";
import { readTaskIndex } from "./core/task-index.js";
import type { Registry, RegistryContract, SpecContract, TaskContract, WbsDocument } from "./core/types.js";
import { readWbs } from "./core/wbs.js";

export const generatedContractsDocPath = "docs/generated/scwbs-contracts.md";

export type DocsGenerateOptions = {
  check?: boolean;
};

function packageVersion(): string {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version is missing or invalid");
  }
  return packageJson.version;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function taskStatusById(root: string): Map<string, string> {
  const result = readTaskIndex(root);
  return new Map(result.index?.tasks.map((entry) => [entry.id, entry.status]) ?? []);
}

function registrySpecForTask(registry: Registry | undefined, task: TaskContract): RegistryContract | undefined {
  return registry?.contracts.find((contract) =>
    contract.type === "spec" && (contract.relatedTask === task.id || contract.featureId === task.featureId)
  );
}

function specForTask(
  registry: Registry | undefined,
  specs: Array<{ spec?: SpecContract; path: string }>,
  task: TaskContract
): SpecContract | undefined {
  const contract = registrySpecForTask(registry, task);
  if (contract) return specs.find((entry) => entry.path === contract.path)?.spec;
  return specs.find((entry) => entry.spec?.featureId === task.featureId)?.spec;
}

function wbsNode(wbs: WbsDocument, task: TaskContract): { code: string; name: string } {
  const node = wbs.nodes.find((candidate) => candidate.id === task.wbsNodeId);
  return { code: node?.code ?? "?", name: node?.name ?? task.wbsNodeId };
}

function formatGeneratedStatusSection(root: string): string[] {
  const report = buildStatusJsonOutput(root);
  return [
    "## WBS Status",
    "",
    `- Project: ${markdownCell(report.project)}`,
    `- Total nodes: ${report.wbsStatus.total}`,
    ...Object.entries(report.wbsStatus.counts).map(([status, count]) => `- ${status}: ${count}`),
    `- Evidence missing: ${report.evidenceMissing.length === 0 ? "None" : report.evidenceMissing.join(", ")}`,
    `- Blocking relations: ${report.blockingRelations.length}`,
    ""
  ];
}

function formatGeneratedTaskSection(root: string, wbs: WbsDocument): string[] {
  const { registry } = readRegistry(root);
  const specs = listSpecs(root);
  const statuses = taskStatusById(root);
  const tasks = listActiveTasks(root).flatMap((entry) => entry.task ? [entry.task] : []).sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    "## Task Contracts",
    "",
    "| Task ID | Status | WBS | Spec |",
    "| --- | --- | --- | --- |"
  ];
  if (tasks.length === 0) lines.push("| None |  |  |  |");
  for (const task of tasks) {
    const node = wbsNode(wbs, task);
    const spec = specForTask(registry, specs, task);
    const specLabel = spec ? `${spec.id} (${spec.status})` : "None";
    lines.push(`| ${markdownCell(task.id)} | ${statuses.get(task.id) ?? "planned"} | ${markdownCell(`${node.code} ${node.name}`)} | ${markdownCell(specLabel)} |`);
  }
  lines.push("");
  return lines;
}

function formatGeneratedHumanGateSection(root: string): string[] {
  const tasks = listActiveTasks(root).flatMap((entry) => entry.task ? [entry.task] : [])
    .filter((task) => task.humanGateRequiredPaths.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    "## Human Gate Declarations",
    "",
    "| Task ID | Approval | Required paths |",
    "| --- | --- | --- |"
  ];
  if (tasks.length === 0) lines.push("| None |  |  |");
  for (const task of tasks) {
    const { approval } = readApproval(root, task.id);
    lines.push(`| ${markdownCell(task.id)} | ${approval?.status ?? "not-requested"} | ${markdownCell(task.humanGateRequiredPaths.join(", "))} |`);
  }
  lines.push("");
  return lines;
}

export function buildGeneratedContractsMarkdown(root: string): string {
  const wbs = readWbs(root);
  const lines = [
    "<!-- Generated by `scwbs docs generate`; do not edit manually. -->",
    "# SC-WBS Contract Summary",
    "",
    "This file is derived from the current WBS, Task Contracts, Specs, and Approval records.",
    "",
    ...formatGeneratedStatusSection(root),
    ...formatGeneratedTaskSection(root, wbs),
    ...formatGeneratedHumanGateSection(root)
  ];
  return `${lines.join("\n")}\n`;
}

export function runDocsGenerate(root: string, options: DocsGenerateOptions = {}): number {
  try {
    const expected = buildGeneratedContractsMarkdown(root);
    const outputPath = resolveFrom(root, generatedContractsDocPath);
    if (options.check) {
      if (!existsSync(outputPath)) {
        console.error(`STALE ${generatedContractsDocPath}: generated file is missing`);
        return 1;
      }
      const current = readFileSync(outputPath, "utf8");
      if (current !== expected) {
        console.error(`STALE ${generatedContractsDocPath}: regenerate with scwbs docs generate`);
        return 1;
      }
      console.log(`PASS docs generate --check (${generatedContractsDocPath})`);
      return 0;
    }

    mkdirSync(path.dirname(outputPath), { recursive: true });
    if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== expected) {
      writeFileSync(outputPath, expected, "utf8");
    }
    console.log(`generated ${generatedContractsDocPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
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
    .version(packageVersion())
    .exitOverride()
    .showHelpAfterError(true)
    .showSuggestionAfterError(true);

  const commandContext: CommandContext = {
    root,
    setExitCode(code) {
      exitCode = code;
    }
  };

  program
    .command("init")
    .description("Initialize a new project")
    .option("--profile <profile>", "profile lean|standard|strict")
    .option("--agent <agent>", "agent type")
    .option("--lang <lang>", "locale id (ja, en, or a bundled locale; fallback is deterministic)")
    .action((opts) => { exitCode = runInit(root, opts); });

  program
    .command("update")
    .option("--agent <agent>")
    .option("--dry-run")
    .option("--json")
    .action((opts) => { exitCode = runAgentUpdate(root, opts); });

  const version = program.command("version").description("Show the installed scwbs version and release status");
  version
    .command("check")
    .description("Compare the installed version with the verified current stable release")
    .option("--manifest <path>", "use a local release-manifest.json for offline verification")
    .option("--artifact <path>", "verify a local tarball against the manifest SHA-256")
    .option("--repo <owner/name>", "GitHub repository used to find the latest release")
    .option("--timeout-ms <milliseconds>", "release lookup timeout")
    .option("--json", "output a versioned JSON report")
    .action((options) => {
      void runVersionCheck(root, {
        manifestPath: options.manifest,
        artifactPath: options.artifact,
        repository: options.repo,
        timeoutMs: options.timeoutMs ? Number(options.timeoutMs) : undefined,
        json: options.json ?? false
      }).then((code) => {
        exitCode = code;
        process.exitCode = code;
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        process.exitCode = 1;
      });
    });
  version.action((options) => { exitCode = runVersion(root, { json: options.json ?? false }); });
  version.option("--json", "output a versioned JSON report");

  program
    .command("upgrade")
    .description("Propose an exact release artifact upgrade without mutating the consumer")
    .option("--dry-run", "required: generate a read-only upgrade proposal")
    .option("--manifest <path>", "use a local release-manifest.json for offline verification")
    .option("--artifact <path>", "verify a local tarball against the manifest SHA-256")
    .option("--repo <owner/name>", "GitHub repository used to find the latest release")
    .option("--timeout-ms <milliseconds>", "release lookup timeout")
    .option("--json", "output a versioned JSON report")
    .action((options) => {
      void runUpgrade(root, {
        dryRun: options.dryRun ?? false,
        manifestPath: options.manifest,
        artifactPath: options.artifact,
        repository: options.repo,
        timeoutMs: options.timeoutMs ? Number(options.timeoutMs) : undefined,
        json: options.json ?? false
      }).then((code) => {
        exitCode = code;
        process.exitCode = code;
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = 1;
        process.exitCode = 1;
      });
    });

  const pack = program.command("pack").description("Inspect and install signed-by-digest Governance Packs without executable hooks");
  pack.command("inspect")
    .argument("<source>")
    .option("--ref <ref>", "pinned local Git ref")
    .option("--json")
    .action((source: string, opts) => { exitCode = runPackInspect(root, source, { ref: opts.ref, json: opts.json ?? false }); });
  pack.command("install")
    .argument("<source>")
    .option("--ref <ref>", "pinned local Git ref")
    .option("--pin", "require digest-pinned installation")
    .option("--dry-run", "show changes without writing")
    .option("--json")
    .action((source: string, opts) => { exitCode = runPackInstall(root, source, { ref: opts.ref, pin: opts.pin ?? false, dryRun: opts.dryRun ?? false, json: opts.json ?? false }); });
  pack.command("list")
    .option("--json")
    .action((opts) => { exitCode = runPackList(root, opts); });
  pack.command("search")
    .argument("<term>")
    .option("--json")
    .action((term: string, opts) => { exitCode = runPackSearch(root, term, opts); });
  pack.command("info")
    .argument("<id>")
    .option("--json")
    .action((id: string, opts) => { exitCode = runPackInfo(root, id, opts); });
  pack.command("update")
    .argument("<id>")
    .option("--source <source>", "replacement local pack source")
    .option("--ref <ref>", "pinned local Git ref")
    .option("--dry-run", "show changes without writing")
    .option("--json")
    .action((id: string, opts) => { exitCode = runPackUpdate(root, id, { source: opts.source, ref: opts.ref, pin: true, dryRun: opts.dryRun ?? false, json: opts.json ?? false }); });
  pack.command("remove")
    .argument("<id>")
    .option("--dry-run", "show policy impact without writing")
    .option("--json")
    .action((id: string, opts) => { exitCode = runPackRemove(root, id, { dryRun: opts.dryRun ?? false, json: opts.json ?? false }); });

  const agent = program.command("agent");
  agent
    .command("list")
    .description("List versioned agent adapters")
    .option("--json")
    .action((opts) => { exitCode = runAgentList(opts); });
  agent
    .command("inspect")
    .argument("<agent>")
    .description("Inspect one agent adapter")
    .option("--json")
    .action((agentName: string, opts) => { exitCode = runAgentInspect(agentName, opts); });
  agent
    .command("doctor")
    .description("Validate all agent adapter paths")
    .option("--all", "check every registered adapter")
    .option("--json")
    .action((opts) => { exitCode = runAgentDoctor(root, opts); });
  agent
    .command("add")
    .argument("<agent>")
    .option("--json")
    .action((agentName: string, opts) => { exitCode = runAgentAdd(root, agentName, opts); });
  agent
    .command("remove")
    .argument("<agent>")
    .option("--json")
    .action((agentName: string, opts) => { exitCode = runAgentRemove(root, agentName, opts); });
  agent
    .command("set-primary")
    .argument("<agent>")
    .option("--json")
    .action((agentName: string, opts) => { exitCode = runAgentSetPrimary(root, agentName, opts); });

  const risk = program.command("risk").description("Manage the versioned Risk Register");
  risk.command("list")
    .option("--limit <count>", "maximum number of risks")
    .option("--json")
    .action((opts) => { exitCode = runRiskList(root, opts); });
  risk.command("show")
    .argument("<id>")
    .option("--json")
    .action((id: string, opts) => { exitCode = runRiskShow(root, id, opts); });
  const riskFields = (command: Command, update = false) => {
    if (!update) {
      command.requiredOption("--id <id>")
        .requiredOption("--title <title>")
        .requiredOption("--likelihood <1-5>")
        .requiredOption("--impact <1-5>")
        .requiredOption("--owner <owner>");
    } else {
      command.option("--title <title>")
        .option("--likelihood <1-5>")
        .option("--impact <1-5>")
        .option("--owner <owner>");
    }
    return command
      .option("--strategy <strategy>", "avoid|mitigate|transfer|accept")
      .option("--actions <items>", "comma-separated treatment actions")
      .option("--verification <items>", "comma-separated verification steps")
      .option("--tasks <ids>", "comma-separated Task IDs")
      .option("--specs <ids>", "comma-separated Spec IDs")
      .option("--requirements <ids>", "comma-separated Requirement IDs")
      .option("--status <status>", "open|mitigated|accepted|closed")
      .option("--dry-run")
      .option("--json");
  };
  riskFields(risk.command("add"))
    .action((opts) => { exitCode = runRiskAdd(root, opts); });
  riskFields(risk.command("update").argument("<id>"), true)
    .action((id: string, opts) => { exitCode = runRiskUpdate(root, id, opts); });
  risk.command("accept")
    .argument("<id>")
    .requiredOption("--actor <actor>", "must be human")
    .requiredOption("--reason <reason>", "exact TTY confirmation")
    .option("--json")
    .action((id: string, opts) => { exitCode = runRiskAccept(root, id, opts); });

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
  docs
    .command("generate")
    .description("Generate deterministic Markdown from SC-WBS contracts")
    .option("--check", "check generated Markdown freshness without writing")
    .action((opts) => { exitCode = runDocsGenerate(root, { check: opts.check ?? false }); });

  registerDiscoveryCommands(program, commandContext);
  registerProjectCommands(program, commandContext);

  const ci = program.command("ci").description("Plan and classify CI execution");
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

  const checks = program.command("checks").description("Run and inspect required checks");
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
    .option("--github", "probe optional GitHub CLI, auth, origin, and read capabilities")
    .option("--json", "output as JSON")
    .action((opts) => { exitCode = runDoctor(root, { fix: opts.fix ?? false, github: opts.github ?? false, json: opts.json ?? false }); });

  program
    .command("health")
    .description("Check repository health")
    .option("--json", "output a versioned JSON report")
    .option("--verbose", "show every health issue")
    .option("--governance-cost", "include warning-only governance cost budget status")
    .action((opts) => { exitCode = runHealth(root, { json: opts.json ?? false, verbose: opts.verbose ?? false, governanceCost: opts.governanceCost ?? false }); });

  const metrics = program.command("metrics").description("Measure governance cost and repository metrics");
  metrics
    .command("governance")
    .description("Measure governance cost without writing artifacts")
    .option("--json", "output a versioned JSON summary")
    .action((opts) => { exitCode = runMetricsGovernance(root, { json: opts.json ?? false }); });

  program
    .command("status")
    .description("Show repository status")
    .option("--json", "output a versioned JSON report")
    .option("--strict", "fail when completed or archived Task completion trust is not fully verified")
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
    .option("--json", "output a versioned JSON action contract")
    .action((opts) => { exitCode = runNext(root, { json: opts.json ?? false }); });

  program
    .command("ui")
    .description("Show the text dashboard")
    .option("--json", "output a versioned JSON dashboard")
    .action((opts) => { exitCode = runUi(root, { json: opts.json ?? false }); });

  program
    .command("serve")
    .description("Start the localhost read-only dashboard")
    .option("--port <port>", "bind to 127.0.0.1 on a port from 0 to 65535 (0 selects a free port)")
    .action((opts) => { exitCode = runServe(root, { port: opts.port === undefined ? undefined : Number(opts.port) }); });

  program
    .command("mcp")
    .description("Run the stdio-only MCP server")
    .option("--stdio", "run the MCP JSON-RPC server over stdin/stdout")
    .action((opts) => {
      if (!opts.stdio) {
        console.error("scwbs mcp requires --stdio; network listeners are not supported");
        exitCode = 2;
        return;
      }
      exitCode = runMcpStdio(root);
    });

  const index = program.command("index").description("Manage the rebuildable local navigation index");
  index.command("rebuild").option("--json", "output a versioned JSON result").action((opts) => { exitCode = runIndexRebuild(root, { json: opts.json ?? false }); });
  index.command("status").option("--json", "output a versioned JSON result").action((opts) => { exitCode = runIndexStatus(root, { json: opts.json ?? false }); });
  index.command("verify").option("--json", "output a versioned JSON result").action((opts) => { exitCode = runIndexVerify(root, { json: opts.json ?? false }); });

  program
    .command("query")
    .description("Search the derived local index without exposing SQL")
    .argument("[text]", "bounded text or kind alias")
    .option("--kind <kinds>", "comma-separated record kinds")
    .option("--status <status>", "exact indexed status")
    .option("--unverified", "show unverified requirements")
    .option("--stale", "show records whose source hash changed")
    .option("--limit <count>", "maximum results", (value) => Math.max(1, Math.min(100, Number(value))))
    .option("--json", "output a versioned JSON result")
    .action((text: string | undefined, opts) => { exitCode = runQuery(root, text, { kind: opts.kind, status: opts.status, unverified: opts.unverified ?? false, stale: opts.stale ?? false, limit: opts.limit, json: opts.json ?? false }); });

  program
    .command("finish")
    .description("Finish a task")
    .option("--task <id>", "task id")
    .option("--base <ref>", "base reference")
    .option("--pr <number>", "pull request number")
    .option("--pull-request <number>", "pull request number (legacy)")
    .option("--rerun-checks", "rerun required checks even when cached results are valid")
    .option("--preflight", "validate readiness without required checks or tracked artifact changes; record a local lifecycle receipt")
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
      const resolveRequested = reasonParts[0] === "resolve";
      const reason = resolveRequested
        ? (typeof opts.reason === "string" ? opts.reason.trim() : "")
        : reasonParts.join(" ").trim() || (opts.reason as string) || "";
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
    .description("Legacy alias for Task pre-flight; accepts existing Task IDs only")
    .argument("<task-id>", "existing Task Contract id")
    .action((taskId: string) => {
      exitCode = runStart(root, taskId);
    });

  program
    .command("plan")
    .description("Build an Approach Map and a 1-3 Task Ready Window from an approved spec")
    .option("--spec <id>", "spec id")
    .option("--replan-reason <text>", "required reason when replacing an existing plan")
    .option("--json", "output a versioned JSON result")
    .action((opts) => {
      if (!opts.spec) {
        console.error("Missing --spec <spec-id>");
        exitCode = 2;
        return;
      }
      exitCode = runPlan(root, opts.spec, {
        replanReason: opts.replanReason,
        json: opts.json ?? false
      });
    });

  program
    .command("merge")
    .description("Fail-closed merge path requiring aggregate validate success")
    .requiredOption("--pr <number>", "pull request number")
    .option("--preflight-only", "verify without merging")
    .option("--json", "output a versioned JSON report")
    .action((opts) => {
      const pullRequest = Number(opts.pr);
      if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
        console.error("Invalid --pr; expected a positive integer");
        exitCode = 2;
        return;
      }
      exitCode = runMerge(root, pullRequest, {
        preflightOnly: opts.preflightOnly ?? false,
        json: opts.json ?? false
      });
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
    .option("--json", "output a versioned JSON graph")
    .action((opts) => {
      if (!opts.task) {
        console.error("Missing --task <task-id>");
        exitCode = 2;
        return;
      }
      exitCode = runTrace(root, opts.task, { json: opts.json ?? false });
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

  registerGovernanceCommands(program, commandContext);
  registerTaskCommands(program, commandContext);
  registerWbsCommands(program, commandContext);

  // Keep the top-level help readable for consumers that index the command
  // labels while still showing per-command options in Commander output.
  program.addHelpText("after", "\nNavigation command labels: next Show next suggested action; ui Show the text dashboard; trace Trace task dependencies.\n");

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
  process.exitCode = exitCode;
}
