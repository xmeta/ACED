export const CHECK_OUTPUT_SUMMARY_LIMIT = 1000;

const TRUNCATED_MARKER = "[truncated]";
const REDACTED = "[redacted]";
const DIAGNOSTIC_LINE_LIMIT = 300;

type DiagnosticGroup = {
  failedTest: string;
  cause?: string;
  rerun?: string;
};

function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`
    )
    .replace(/(\bauthorization\s*:\s*bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential)\s*([:=])\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED);
}

function boundedLine(line: string): string {
  if (line.length <= DIAGNOSTIC_LINE_LIMIT) return line;
  return `${line.slice(0, DIAGNOSTIC_LINE_LIMIT - TRUNCATED_MARKER.length - 1)} ${TRUNCATED_MARKER}`;
}

function diagnosticGroups(lines: string[]): DiagnosticGroup[] {
  const groups: DiagnosticGroup[] = [];
  let current: DiagnosticGroup | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("failed test=")) {
      current = { failedTest: boundedLine(line) };
      groups.push(current);
    } else if (current && line.startsWith("cause=") && current.cause === undefined) {
      current.cause = boundedLine(line);
    } else if (current && line.startsWith("rerun=") && current.rerun === undefined) {
      current.rerun = boundedLine(line);
    }
  }
  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = [group.failedTest, group.cause ?? "", group.rerun ?? ""].join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupText(group: DiagnosticGroup): string {
  return [group.failedTest, group.cause, group.rerun].filter((line): line is string => Boolean(line)).join("\n");
}

function headTail(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit <= TRUNCATED_MARKER.length + 2) return TRUNCATED_MARKER.slice(0, limit);
  const available = limit - TRUNCATED_MARKER.length - 2;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}\n${TRUNCATED_MARKER}\n${value.slice(-tail)}`;
}

function residualOutput(lines: string[]): string {
  const content: string[] = [];
  const progress: string[] = [];
  const seenProgress = new Set<string>();
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (
      trimmed.startsWith("failed test=")
      || trimmed.startsWith("cause=")
      || trimmed.startsWith("rerun=")
    ) {
      continue;
    }
    if (trimmed.startsWith("scwbs progress ")) {
      const key = trimmed
        .replace(/\belapsed=\d+s\b/g, "elapsed=*")
        .replace(/\bpid=\d+\b/g, "pid=*")
        .replace(/\bstartedAt=\S+/g, "startedAt=*");
      if (!seenProgress.has(key)) {
        seenProgress.add(key);
        progress.push(trimmed);
      }
      continue;
    }
    content.push(line);
  }
  const body = content.join("\n").trim();
  const representativeProgress = progress.length > 0
    ? `[progress summaries=${progress.length}]\n${progress[0]}`
    : "";
  return [body, representativeProgress].filter(Boolean).join("\n");
}

export function summarizeCheckOutput(
  output: string | null | undefined,
  limit = CHECK_OUTPUT_SUMMARY_LIMIT
): string | undefined {
  if (!Number.isInteger(limit) || limit <= 0) return undefined;
  const normalized = redactSecrets((output ?? "").replace(/\r\n?/g, "\n")).trim();
  if (!normalized) return undefined;
  const lines = normalized.split("\n");
  const groups = diagnosticGroups(lines);
  if (groups.length === 0) return headTail(residualOutput(lines), limit) || undefined;

  const selected: string[] = [];
  let used = 0;
  for (const group of groups) {
    const text = groupText(group);
    const separator = selected.length > 0 ? 1 : 0;
    if (used + separator + text.length > limit) break;
    selected.push(text);
    used += separator + text.length;
  }

  const omitted = groups.length - selected.length;
  const omittedMarker = omitted > 0 ? `[${omitted} diagnostic group(s) omitted]` : "";
  let summary = selected.join("\n");
  if (omittedMarker && summary.length + 1 + omittedMarker.length <= limit) {
    summary = `${summary}\n${omittedMarker}`;
  }

  const residual = residualOutput(lines);
  const remaining = limit - summary.length - (residual ? 1 : 0);
  if (residual && remaining > TRUNCATED_MARKER.length) {
    summary = `${summary}\n${headTail(residual, remaining)}`;
  }
  return summary.slice(0, limit) || undefined;
}
