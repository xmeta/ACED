#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runAiBlock, runAiNextTask } from "./commands/ai-queue.js";
import { runAiPacket } from "./commands/ai-packet.js";
import { runApprovalRequest } from "./commands/approval-request.js";
import { runCheck } from "./commands/check.js";
import { runCheckDiff } from "./commands/check-diff.js";
import { runHealth } from "./commands/health.js";
import { runInit } from "./commands/init.js";
import { runReviewQueue } from "./commands/review-queue.js";
import { runStatus } from "./commands/status.js";
import { runTaskGenerate } from "./commands/task-generate.js";
import { runTaskLock } from "./commands/task-lock.js";
import { runWbsApply, runWbsValidate } from "./commands/wbs.js";

function usage(): void {
  console.log(`Usage:
  scwbs init
  scwbs check
  scwbs health
  scwbs check-diff --task <task-id>
  scwbs ai packet --task <task-id> [--relation-depth <n>]
  scwbs ai block --task <task-id> --reason <reason>
  scwbs ai next-task
  scwbs approval request --task <task-id> [--pull-request <id>] [--note <text>] [--force]
  scwbs task generate --node <node-id> --task <task-id> [--force]
  scwbs task lock --task <task-id>
  scwbs status
  scwbs review-queue
  scwbs wbs validate
  scwbs wbs apply <change-set.json> [--force] [--output <file>]
`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function textAfter(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const parts: string[] = [];
  for (let i = index + 1; i < args.length; i += 1) {
    const part = args[i];
    if (!part || part.startsWith("--")) break;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function numberAfter(args: string[], flag: string, fallback: number): number {
  const value = valueAfter(args, flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
  if (command === "review-queue") return runReviewQueue(root);
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
    return runAiPacket(root, taskId, numberAfter(argv, "--relation-depth", 1));
  }
  if (command === "ai" && subcommand === "block") {
    const taskId = valueAfter(argv, "--task");
    const reason = valueAfter(argv, "--reason");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    if (!reason) {
      console.error("Missing --reason <reason>");
      return 2;
    }
    return runAiBlock(root, taskId, reason);
  }
  if (command === "ai" && subcommand === "next-task") return runAiNextTask(root);
  if (command === "approval" && subcommand === "request") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runApprovalRequest(root, taskId, {
      pullRequest: valueAfter(argv, "--pull-request"),
      note: textAfter(argv, "--note"),
      force: argv.includes("--force")
    });
  }
  if (command === "task" && subcommand === "generate") {
    const nodeId = valueAfter(argv, "--node");
    const taskId = valueAfter(argv, "--task");
    if (!nodeId) {
      console.error("Missing --node <node-id>");
      return 2;
    }
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runTaskGenerate(root, nodeId, taskId, { force: argv.includes("--force") });
  }
  if (command === "task" && subcommand === "lock") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runTaskLock(root, taskId);
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
