import { matchesAny } from "./glob.js";

export type CiPlanReason = { code: string; message: string };

export type CiPlanFileClassification = {
  consideredFiles: string[];
  excludedBootstrapFiles: string[];
  executionClass: "routine" | "standard" | "high-risk";
  reasons: CiPlanReason[];
};

function reason(code: string, message: string): CiPlanReason {
  return { code, message };
}

export function uniqueCiPlanReasons(reasons: CiPlanReason[]): CiPlanReason[] {
  const seen = new Set<string>();
  return reasons.filter((item) => {
    const key = `${item.code}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function classifyCiPlanFiles(
  branchFiles: string[],
  bootstrapFiles: string[],
  humanGateRequiredPaths: string[],
  initialReasons: CiPlanReason[],
  issueReasons: CiPlanReason[]
): CiPlanFileClassification {
  const consideredFiles = branchFiles.filter((file) => !bootstrapFiles.includes(file)).sort();
  const reasons = [...initialReasons];
  if (issueReasons.some((item) => ["git.shallow", "git.base.missing", "git.mergeBase.missing", "git.diff.failed"].includes(item.code))) {
    reasons.push(reason("classification.provenance.unverified", "Repository history or the classified branch diff cannot be verified"));
  }
  if (issueReasons.some((item) => item.code.includes("taskAuthority") || item.code.includes("checkCoverage.unclassified"))) {
    reasons.push(reason("classification.authorityOrCoverage.unverified", "Authority or implementation coverage cannot be verified"));
  }
  if (consideredFiles.some((file) => matchesAny(file, humanGateRequiredPaths))) {
    reasons.push(reason("classification.path.humanGate", "A Human Gate path is in the classified change set"));
  }
  if (consideredFiles.some((file) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|.*schema.*|.*migration.*|.*auth.*|.*permission.*|.*release.*)$/.test(file) || file.startsWith(".github/") || file.startsWith("wjs/"))) {
    reasons.push(reason("classification.path.highRisk", "A dependency, schema, migration, authority, release, workflow, or submodule path is in the classified change set"));
  }
  const executionClass = reasons.length > 0 ? "high-risk"
    : consideredFiles.some((file) => file.startsWith("src/") || file.startsWith("tests/")) ? "standard"
      : "routine";
  if (reasons.length === 0) {
    reasons.push(reason(`classification.${executionClass}`, executionClass === "routine"
      ? "Only non-implementation, non-gated files remain after verified bootstrap metadata exclusion"
      : "Implementation or test files require the Standard execution class"));
  }
  return {
    consideredFiles,
    excludedBootstrapFiles: bootstrapFiles.filter((file) => branchFiles.includes(file)).sort(),
    executionClass,
    reasons: uniqueCiPlanReasons(reasons)
  };
}
