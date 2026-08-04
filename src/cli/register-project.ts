import type { Command } from "commander";
import { runProjectBootstrap } from "../commands/discovery.js";
import type { CommandContext } from "./command-context.js";

export function registerProjectCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  const project = program.command("project").description("Manage project bootstrap artifacts");
  project
    .command("bootstrap")
    .description("Create a bounded Discovery Probe without a delivery Task Contract")
    .argument("<goal...>", "decision-driving project goal")
    .option("--json", "output versioned JSON")
    .action((goalParts: string[], options) => {
      const goal = goalParts.join(" ").trim();
      if (!goal) {
        console.error("Missing project goal");
        setExitCode(2);
        return;
      }
      setExitCode(runProjectBootstrap(root, goal, options.json ?? false));
    });
}
