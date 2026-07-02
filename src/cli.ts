#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runAiBlock, runAiNextTask } from "./commands/ai-queue.js";
import { runAiPacket } from "./commands/ai-packet.js";
import { runAiRun } from "./commands/ai-run.js";
import { runApprovalApprove, runApprovalRequest } from "./commands/approval-request.js";
import { runCheck } from "./commands/check.js";
import { runCheckDiff } from "./commands/check-diff.js";
import { runCompletionApply } from "./commands/completion.js";
import { runDoctor } from "./commands/doctor.js";
import { runEvidenceCollect } from "./commands/evidence-collect.js";
import { runHealth } from "./commands/health.js";
import { runInit } from "./commands/init.js";
import { runLiteTask, runPromote } from "./commands/lite.js";
import { runNext } from "./commands/next.js";
import { runPlan } from "./commands/plan.js";
import { runProfileSet, runProfileShow } from "./commands/profile.js";
import { runRegistryRebuild } from "./commands/registry-rebuild.js";
import { runReviewRequest, runReviewRoute } from "./commands/review-request.js";
import { runReviewQueue } from "./commands/review-queue.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runTaskGenerate } from "./commands/task-generate.js";
import { runTaskLock } from "./commands/task-lock.js";
import { runTaskRefresh } from "./commands/task-refresh.js";
import { runTrace } from "./commands/trace.js";
import { runServe, runUi } from "./commands/ui.js";
import { runWbsApply, runWbsValidate } from "./commands/wbs.js";

function usage(): void {
  console.log(`Usage:
  scwbs init [--profile lean|standard|strict] [--agent codex] [--lang ja|en]
  scwbs check
  scwbs doctor
  scwbs health
  scwbs check-diff --task <task-id> [--base <ref>]
  scwbs ai packet --task <task-id> [--relation-depth <n>]
  scwbs ai run --task <task-id> [--agent codex]
  scwbs ai block --task <task-id> --reason <reason>
  scwbs ai next-task
  scwbs approval request --task <task-id> [--pull-request <id>] [--note <text>] [--force]
  scwbs approval approve --task <task-id> [--pull-request <id>] [--reason <text>] [--force]
  scwbs completion apply --tasks <task-id[,task-id...]> --task <completion-task-id> [--reason <text>] [--apply] [--allow-root]
  scwbs evidence collect --task <task-id> [--base <ref>] [--pull-request <id>] [--force]
  scwbs registry rebuild [--check] [--force]
  scwbs profile show
  scwbs profile set <lean|standard|strict>
  scwbs review request --task <task-id> [--pull-request <id>] [--force]
  scwbs review route --task <task-id>
  scwbs next
  scwbs start <goal>
  scwbs plan --spec <spec-id>
  scwbs lite task <title>
  scwbs promote --task <task-id>
  scwbs trace --task <task-id>
  scwbs ui
  scwbs serve
  scwbs task generate --node <node-id> --task <task-id> [--force]
  scwbs task lock --task <task-id>
  scwbs task refresh --task <task-id> [--apply]
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

  if (command === "init") return runInit(root, {
    profile: valueAfter(argv, "--profile"),
    agent: valueAfter(argv, "--agent"),
    lang: valueAfter(argv, "--lang")
  });
  if (command === "check") return runCheck(root);
  if (command === "doctor") return runDoctor(root);
  if (command === "health") return runHealth(root);
  if (command === "status") return runStatus(root);
  if (command === "review-queue") return runReviewQueue(root);
  if (command === "next") return runNext(root);
  if (command === "ui") return runUi(root);
  if (command === "serve") return runServe();
  if (command === "start") {
    const goal = argv.slice(1).join(" ").trim();
    if (!goal) {
      console.error("Missing goal text");
      return 2;
    }
    return runStart(root, goal);
  }
  if (command === "plan") {
    const specId = valueAfter(argv, "--spec");
    if (!specId) {
      console.error("Missing --spec <spec-id>");
      return 2;
    }
    return runPlan(root, specId);
  }
  if (command === "promote") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runPromote(root, taskId);
  }
  if (command === "trace") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runTrace(root, taskId);
  }
  if (command === "check-diff") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runCheckDiff(root, taskId, { baseRef: valueAfter(argv, "--base") });
  }
  if (command === "ai" && subcommand === "packet") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    const format = valueAfter(argv, "--format") ?? "default";
    if (!["default", "compact", "codex", "claude", "cursor"].includes(format)) {
      console.error("Invalid --format");
      return 2;
    }
    return runAiPacket(root, taskId, numberAfter(argv, "--relation-depth", 1), format as "default" | "compact" | "codex" | "claude" | "cursor");
  }
  if (command === "ai" && subcommand === "run") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runAiRun(root, taskId, valueAfter(argv, "--agent"));
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
  if (command === "approval" && subcommand === "approve") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runApprovalApprove(root, taskId, {
      pullRequest: valueAfter(argv, "--pull-request"),
      reason: textAfter(argv, "--reason"),
      force: argv.includes("--force")
    });
  }
  if (command === "completion" && subcommand === "apply") {
    return runCompletionApply(root, valueAfter(argv, "--tasks"), valueAfter(argv, "--task"), {
      reason: textAfter(argv, "--reason"),
      apply: argv.includes("--apply"),
      allowRoot: argv.includes("--allow-root")
    });
  }
  if (command === "evidence" && subcommand === "collect") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runEvidenceCollect(root, taskId, {
      force: argv.includes("--force"),
      baseRef: valueAfter(argv, "--base"),
      pullRequest: valueAfter(argv, "--pull-request")
    });
  }
  if (command === "registry" && subcommand === "rebuild") {
    return runRegistryRebuild(root, { check: argv.includes("--check"), force: argv.includes("--force") });
  }
  if (command === "profile" && subcommand === "show") return runProfileShow(root);
  if (command === "profile" && subcommand === "set") {
    if (!third) {
      console.error("Missing profile");
      return 2;
    }
    return runProfileSet(root, third);
  }
  if (command === "review" && subcommand === "request") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runReviewRequest(root, taskId, {
      pullRequest: valueAfter(argv, "--pull-request"),
      force: argv.includes("--force")
    });
  }
  if (command === "review" && subcommand === "route") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runReviewRoute(root, taskId);
  }
  if (command === "lite" && subcommand === "task") {
    const title = argv.slice(2).join(" ").trim();
    if (!title) {
      console.error("Missing lite task title");
      return 2;
    }
    return runLiteTask(root, title);
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
  if (command === "task" && subcommand === "refresh") {
    const taskId = valueAfter(argv, "--task");
    if (!taskId) {
      console.error("Missing --task <task-id>");
      return 2;
    }
    return runTaskRefresh(root, taskId, { apply: argv.includes("--apply") });
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
