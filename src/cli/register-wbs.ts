import type { Command } from "commander";
import { runWbsApply, runWbsCandidates, runWbsMergePlan, runWbsValidate, runWbsVerifyChangesets } from "../commands/wbs.js";
import type { CommandContext } from "./command-context.js";

export function registerWbsCommands(program: Command, context: CommandContext): void {
  const { root, setExitCode } = context;
  const wbs = program.command("wbs").description("Validate and apply WBS changes");
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
    .command("merge-plan")
    .description("Build a read-only three-way semantic WBS merge plan")
    .requiredOption("--base <ref-or-file>", "base WBS ref or file")
    .requiredOption("--ours <ref-or-file>", "ours WBS ref or file")
    .requiredOption("--theirs <ref-or-file>", "theirs WBS ref or file")
    .option("--write-changeset <file>", "write a WJS-compatible changeset only when the plan is clean")
    .option("--json", "emit versioned JSON output")
    .action((options) => {
      setExitCode(
        runWbsMergePlan(root, {
          base: options.base,
          ours: options.ours,
          theirs: options.theirs,
          writeChangeset: options.writeChangeset
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
