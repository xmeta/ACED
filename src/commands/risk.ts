import { listRisks } from "../core/contracts.js";
import { acceptRisk, addRisk, riskAcceptanceStatus, summarizeRisk, updateRisk, type RiskInput } from "../core/risk.js";
import type { RiskStatus, RiskTreatmentStrategy } from "../core/types.js";

type OutputOptions = { json?: boolean };

function output(value: unknown, json = false): number {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
  return 0;
}

function run(action: () => unknown, options: OutputOptions): number {
  try {
    return output(action(), options.json ?? false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) console.log(JSON.stringify({ version: "scwbs.risk-error.v1", status: "error", error: message }));
    else console.error(message);
    return 1;
  }
}

export function runRiskList(root: string, options: OutputOptions & { limit?: string } = {}): number {
  return run(() => {
    const limit = Math.max(1, Math.min(100, Number(options.limit ?? 100) || 100));
    const entries = listRisks(root).slice(0, limit);
    return {
      version: "scwbs.risk-list.v1",
      risks: entries.filter((entry) => entry.risk).map((entry) => summarizeRisk(root, entry.risk!)),
      issues: entries.flatMap((entry) => entry.issues)
    };
  }, options);
}

export function runRiskShow(root: string, id: string, options: OutputOptions = {}): number {
  return run(() => {
    const entry = listRisks(root).find((candidate) => candidate.risk?.id === id);
    if (!entry?.risk) throw new Error(`${id} was not found or is invalid`);
    return { version: "scwbs.risk-show.v1", risk: entry.risk, summary: summarizeRisk(root, entry.risk), acceptanceStatus: riskAcceptanceStatus(root, entry.risk), issues: entry.issues };
  }, options);
}

function parseNumber(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed === undefined) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseInput(options: Record<string, unknown>, id?: string): RiskInput {
  const value = (key: string) => options[key] as string | undefined;
  const input: RiskInput = {
    id: id ?? value("id") ?? "",
    title: value("title") ?? "",
    likelihood: parseNumber(value("likelihood"), "--likelihood"),
    impact: parseNumber(value("impact"), "--impact"),
    owner: value("owner") ?? "",
    strategy: value("strategy") as RiskTreatmentStrategy | undefined,
    actions: value("actions"),
    verification: value("verification"),
    tasks: value("tasks"),
    specs: value("specs"),
    requirements: value("requirements"),
    status: value("status") as RiskStatus | undefined
  };
  if (!input.id || !input.title || !input.owner) throw new Error("--id, --title, and --owner are required");
  return input;
}

export function runRiskAdd(root: string, options: Record<string, unknown> & OutputOptions): number {
  return run(() => ({ version: "scwbs.risk-operation.v1", operation: "add", dryRun: Boolean(options.dryRun), risk: addRisk(root, parseInput(options), Boolean(options.dryRun)) }), options);
}

export function runRiskUpdate(root: string, id: string, options: Record<string, unknown> & OutputOptions): number {
  const current = listRisks(root).find((entry) => entry.risk?.id === id)?.risk;
  if (!current) return run(() => { throw new Error(`${id} was not found or is invalid`); }, options);
  const merged = {
    ...options,
    title: options.title ?? current.title,
    likelihood: options.likelihood ?? String(current.assessment.likelihood),
    impact: options.impact ?? String(current.assessment.impact),
    owner: options.owner ?? current.treatment.owner
  };
  return run(() => ({ version: "scwbs.risk-operation.v1", operation: "update", dryRun: Boolean(options.dryRun), risk: updateRisk(root, id, parseInput(merged, id), Boolean(options.dryRun)) }), options);
}

export function runRiskAccept(root: string, id: string, options: OutputOptions & { actor?: string; reason?: string }): number {
  return run(() => ({ version: "scwbs.risk-operation.v1", operation: "accept", risk: acceptRisk(root, id, options.actor ?? "", options.reason ?? "") }), options);
}
