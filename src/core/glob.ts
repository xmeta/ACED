function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function normalizeGlob(glob: string): string {
  return normalizePath(glob).replace(/\/+/g, "/");
}

function validateSegment(segment: string): string | undefined {
  if ([...segment].some((char) => ["?", "[", "]", "{", "}", "!"].includes(char))) {
    return "only * and ** wildcards are supported";
  }
  if (segment.includes("**") && segment !== "**") return "** must occupy a complete path segment";
  return undefined;
}

export function validateGlobPattern(glob: string): string | undefined {
  const normalized = normalizeGlob(glob);
  if (normalized.length === 0) return "pattern must not be empty";
  return normalized.split("/").map(validateSegment).find(Boolean);
}

function segmentToRegex(segment: string): string {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    pattern += char === "*" ? "[^/]*" : escapeRegex(char);
  }
  return pattern;
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizeGlob(glob);
  const segments = normalized.split("/");
  let pattern = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const previous = segments[index - 1];
    if (segment === "**") {
      if (previous !== "**") pattern += index === 0 ? "" : "/";
      pattern += index === segments.length - 1 ? "(?:[^/]+(?:/[^/]+)*)?" : "(?:[^/]+/)*";
    } else {
      if (index > 0 && previous !== "**") pattern += "/";
      pattern += segmentToRegex(segment);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesGlob(filePath: string, glob: string): boolean {
  if (validateGlobPattern(glob)) return false;
  return globToRegex(glob).test(normalizePath(filePath));
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(filePath, glob));
}
