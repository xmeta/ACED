function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(input: string): string {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesGlob(filePath: string, glob: string): boolean {
  return globToRegex(glob).test(normalizePath(filePath));
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(filePath, glob));
}
