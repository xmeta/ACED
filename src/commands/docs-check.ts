import { collectDocumentLifecycleIssues, documentStatuses, documentLifecyclePath } from "../core/document-lifecycle.js";
import { hasErrors, printIssues } from "../core/report.js";

export type DocsCheckOptions = {
  json?: boolean;
};

export function buildDocsCheckReport(root: string) {
  const result = collectDocumentLifecycleIssues(root, true);
  const counts = Object.fromEntries(documentStatuses.map((status) => [
    status,
    result.manifest?.documents.filter((item) => item.status === status).length ?? 0
  ])) as Record<typeof documentStatuses[number], number>;
  const errors = result.issues.filter((item) => item.severity === "error").length;
  const warnings = result.issues.length - errors;
  return {
    version: "scwbs.docs-check.v1",
    status: errors > 0 ? "fail" as const : warnings > 0 ? "warn" as const : "pass" as const,
    manifestPath: documentLifecyclePath,
    cliVersion: result.cliVersion ?? null,
    summary: {
      documents: result.manifest?.documents.length ?? 0,
      ...counts,
      errors,
      warnings
    },
    issues: result.issues
  };
}

export function runDocsCheck(root: string, options: DocsCheckOptions = {}): number {
  const report = buildDocsCheckReport(root);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.issues.length === 0) {
    console.log(`PASS docs check (${report.summary.documents} document sets)`);
  } else {
    printIssues(report.issues);
    if (!hasErrors(report.issues)) {
      console.log(`PASS docs check with ${report.summary.warnings} warning(s)`);
    }
  }
  return report.status === "fail" ? 1 : 0;
}
