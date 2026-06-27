#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runAiPacket } from "./commands/ai-packet.js";
import { runCheck } from "./commands/check.js";
import { runCheckDiff } from "./commands/check-diff.js";
import { runHealth } from "./commands/health.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runWbsApply, runWbsValidate } from "./commands/wbs.js";

function usage(): void {
  console.log(`Usage:
  scwbs init
  scwbs check
  scwbs health
  scwbs check-diff --task <task-id>
  scwbs ai packet --task <task-id>
  scwbs status
  scwbs wbs validate
  scwbs wbs apply <change-set.json> [--force] [--output <file>]
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(argv = process.argv.slice(2), root = process.cwd()): number {
  const [command, subcommand, third] = argv;

  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }

  if (command === "init") return runInit(root);
  if (command === "check") return runCheck(root);
  if (command === "health") return runHealth(root);
  if (command === "status") return runStatus(root);
  if (command === "check-diff") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runCheckDiff(root, taskId);
  }
  if (command === "ai" && subcommand === "packet") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runAiPacket(root, taskId);
  }
  if (command === "wbs" && subcommand === "validate") return runWbsValidate(root);
  if (command === "wbs" && subcommand === "apply") {
    if (!third) {
      console.error("Missing change-set.json");
      return 2;
    }
    return runWbsApply(root, third, {
      force: argv.includes("--force"),
      output: valueAfter(argv, "--output") ?? valueAfter(argv, "-o")
    });
  }

  usage();
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = main();
  process.exit(exitCode);
}
