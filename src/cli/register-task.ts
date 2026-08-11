import type { Command } from "commander";
import { runLiteTask } from "../commands/lite.js";
import { runTaskGenerate } from "../commands/task-generate.js";
import { runTaskArchive, runTaskIndexRebuild } from "../commands/task-index.js";
import { runTaskLock } from "../commands/task-lock.js";
import { runPolicyExplain, runTaskNew, runTaskPreflight } from "../commands/task-new.js";
import { runTaskRefresh } from "../commands/task-refresh.js";
import { runStart } from "../commands/start.js";
import type { CommandContext } from "./command-context.js";

export function registerTaskCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  const lite = program.command("lite").description("Create lightweight task proposals");
  lite
    .command("task")
    .description("Create a lite task")
    .argument("[title...]", "task title")
    .action((titleParts: string[]) => {
      const title = titleParts.join(" ").trim();
      if (!title) {
        console.error("Missing lite task title");
        setExitCode(2);
        return;
      }
      setExitCode(runLiteTask(root, title));
    });

  const task = program.command("task").description("Manage Task Contracts and lifecycle");
  task
    .command("start")
    .description("Run pre-flight for an existing Task Contract")
    .argument("<task-id>", "existing Task Contract id")
    .action((taskId: string) => {
      setExitCode(runStart(root, taskId));
    });

  task
    .command("preflight")
    .description("Explain task policy cost without creating or mutating a Task Contract")
    .option("--title <title>", "proposed task title")
    .option("--paths <paths>", "proposed paths (comma separated)")
    .option("--profile <profile>", "profile lean|standard|strict")
    .option("--json", "output a versioned JSON report")
    .action((options) => {
      setExitCode(runTaskPreflight(root, options));
    });

  const policy = program.command("policy").description("Explain repository policy without mutating contracts");
  policy
    .command("explain")
    .description("Explain policy impact for a path")
    .argument("<path>", "repository-relative path or pattern")
    .option("--json", "output a versioned JSON report")
    .action((inputPath: string, options) => {
      setExitCode(runPolicyExplain(root, inputPath, { json: options.json ?? false }));
    });

  task
    .command("generate")
    .description("Generate a task")
    .option("--node <id>", "WBS node id")
    .option("--task <id>", "task id")
    .option("--force", "force generation")
    .action((options) => {
      if (!options.node) {
        console.error("Missing --node <node-id>");
        setExitCode(2);
        return;
      }
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runTaskGenerate(root, options.node, options.task, { force: options.force ?? false }));
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
    .action((titleParts: string[], options) => {
      const title = titleParts.join(" ").trim();
      setExitCode(
        runTaskNew(root, title, {
          paths: options.paths,
          forbid: options.forbid,
          gate: options.gate,
          stop: options.stop,
          noStopConditions: options.noStopConditions,
          checks: options.checks,
          wbsNode: options.wbsNode
        })
      );
    });

  task
    .command("lock")
    .description("Lock a task")
    .option("--task <id>", "task id")
    .action((options) => {
      if (!options.task) {
        console.error("Missing --task <task-id>");
        setExitCode(2);
        return;
      }
      setExitCode(runTaskLock(root, options.task));
    });

  const taskIndex = task.command("index").description("Manage the Task Contract lifecycle index");
  taskIndex
    .command("rebuild")
    .description("Check or rebuild contracts/tasks/index.yaml")
    .option("--check", "check index consistency without writing")
    .option("--force", "rebuild the index and synchronize the registry")
    .option("--json", "print bounded JSON summary")
    .action((options) => {
      setExitCode(
        runTaskIndexRebuild(root, {
          check: options.check ?? false,
          force: options.force ?? false,
          json: options.json ?? false
        })
      );
    });

  task
    .command("archive")
    .description("Exclude a terminal Task from default active scans while retaining its records")
    .requiredOption("--task <id>", "task id")
    .option("--json", "print JSON")
    .action((options) => {
      setExitCode(runTaskArchive(root, options.task, { json: options.json ?? false }));
    });

  task
    .command("refresh")
    .description("Refresh a task")
    .option("--task <id>", "task id")
    .option("--affected", "preview Task Contracts affected by current WBS or Spec changes")
    .option("--all", "preview or refresh every Task Contract")
    .option("--apply", "apply changes")
    .action((options) => {
      const selectors = [Boolean(options.task), Boolean(options.affected), Boolean(options.all)].filter(Boolean).length;
      if (selectors !== 1) {
        console.error("Specify exactly one of --task <task-id>, --affected, or --all");
        setExitCode(2);
        return;
      }
      setExitCode(
        runTaskRefresh(root, options.task, {
          apply: options.apply ?? false,
          affected: options.affected ?? false,
          all: options.all ?? false
        })
      );
    });
}
