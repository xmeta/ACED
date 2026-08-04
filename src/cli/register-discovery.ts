import type { Command } from "commander";
import { runDiscoveryConclude, runDiscoveryGoalStart, runDiscoveryNew, runDiscoveryStart } from "../commands/discovery.js";
import { parseBool, type CommandContext } from "./command-context.js";

export function registerDiscoveryCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  const discovery = program.command("discovery").description("Manage bounded Discovery Probes");
  discovery
    .command("new")
    .requiredOption("--probe <id>", "PROBE-prefixed id")
    .requiredOption("--question <text>", "decision-driving question")
    .requiredOption("--timebox <value>", "timebox")
    .requiredOption("--cost-limit <value>", "cost limit")
    .requiredOption("--next-decision <text>", "decision enabled by the probe")
    .option("--hypotheses <items>", "comma-separated hypotheses")
    .option("--activities <items>", "comma-separated activities")
    .option("--evidence-expected <items>", "comma-separated expected evidence")
    .option("--unknowns <items>", "comma-separated unknowns")
    .option("--exit-conditions <items>", "comma-separated exit conditions")
    .option("--delivery-task <id>", "delivery Task blocked until conclusion")
    .option("--json", "output versioned JSON")
    .action((options) => {
      setExitCode(runDiscoveryNew(root, options));
    });
  discovery
    .command("start")
    .argument("[goal...]", "decision-driving goal; creates and starts a Probe")
    .option("--probe <id>", "existing Probe id to activate")
    .option("--timebox <value>", "timebox for a goal-created Probe")
    .option("--cost-limit <value>", "cost limit for a goal-created Probe")
    .option("--next-decision <text>", "decision enabled by a goal-created Probe")
    .option("--json", "output versioned JSON")
    .action((goalParts: string[], options) => {
      if (options.probe && goalParts.length > 0) {
        console.error("Use either --probe <id> or a goal, not both");
        setExitCode(2);
        return;
      }
      if (options.probe) {
        setExitCode(runDiscoveryStart(root, options.probe, options.json ?? false));
        return;
      }
      const goal = goalParts.join(" ").trim();
      if (!goal) {
        console.error("Provide --probe <id> or a discovery goal");
        setExitCode(2);
        return;
      }
      setExitCode(runDiscoveryGoalStart(root, goal, {
        timebox: options.timebox,
        costLimit: options.costLimit,
        nextDecision: options.nextDecision,
        json: options.json ?? false
      }));
    });
  discovery
    .command("conclude")
    .requiredOption("--probe <id>", "Probe id")
    .requiredOption("--outcome <status>", "concluded|inconclusive")
    .option("--facts <items>", "comma-separated learned facts")
    .option("--rejected <items>", "comma-separated rejected hypotheses")
    .option("--remaining <items>", "comma-separated remaining unknowns")
    .option("--exit-conditions-met <boolean>", "whether every exit condition is met")
    .option("--next-decision <text>", "updated next decision")
    .option("--json", "output versioned JSON")
    .action((options) => {
      if (options.outcome !== "concluded" && options.outcome !== "inconclusive") {
        console.error("Invalid --outcome; expected concluded or inconclusive");
        setExitCode(2);
        return;
      }
      setExitCode(
        runDiscoveryConclude(root, options.probe, {
          ...options,
          exitConditionsMet: parseBool(options.exitConditionsMet)
        })
      );
    });
}
