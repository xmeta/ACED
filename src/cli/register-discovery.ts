import type { Command } from "commander";
import { runDiscoveryConclude, runDiscoveryNew, runDiscoveryStart } from "../commands/discovery.js";
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
    .requiredOption("--probe <id>", "Probe id")
    .option("--json", "output versioned JSON")
    .action((options) => {
      setExitCode(runDiscoveryStart(root, options.probe, options.json ?? false));
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
