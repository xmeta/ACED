import type { Command } from "commander";
import { runWbsApply, runWbsCandidates, runWbsValidate, runWbsVerifyChangesets } from "../commands/wbs.js";
import type { CommandContext } from "./command-context.js";

export function registerWbsCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  const wbs = program.command("wbs");
  wbs
    .command("validate")
    .description("Validate WBS")
    .action(() => {
      setExitCode(runWbsValidate(root));
    });

  wbs
    .command("candidates")
    .description("Show WBS candidates")
    .action(() => {
      setExitCode(runWbsCandidates(root));
    });

  wbs
    .command("verify-changesets")
    .description("Verify WBS changesets")
    .option("--base <path>", "base wbs.json path")
    .option("--head <path>", "head wbs.json path")
    .option(
      "--changeset <path>",
      "changeset file path",
      (value: string, previous: string[]) => previous.concat(value),
      [] as string[]
    )
    .action((options) => {
      setExitCode(
        runWbsVerifyChangesets(root, {
          base: options.base,
          head: options.head,
          changeSets: options.changeset ?? []
        })
      );
    });

  wbs
    .command("apply")
    .description("Apply a WBS changeset")
    .argument("<change-set>", "changeset json file")
    .option("--force", "force apply")
    .option("--output <file>", "output file")
    .option("-o <file>", "output file (short)")
    .action((changeSet: string, options) => {
      if (!changeSet) {
        console.error("Missing change-set.json");
        setExitCode(2);
        return;
      }
      setExitCode(
        runWbsApply(root, changeSet, {
          force: options.force ?? false,
          output: options.output ?? options.O
        })
      );
    });
}
