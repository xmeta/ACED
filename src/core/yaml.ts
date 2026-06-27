import { readFileSync } from "node:fs";

type Parsed = Record<string, unknown>;

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSimpleYaml(text: string): Parsed {
  const root: Parsed = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let currentKey: string | undefined;
  let currentObject: Parsed | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    if (!line.startsWith(" ")) {
      currentObject = undefined;
      const match = /^([^:]+):(.*)$/.exec(line);
      if (!match) continue;
      currentKey = match[1].trim();
      const rest = match[2].trim();
      root[currentKey] = rest === "" ? [] : scalar(rest);
      continue;
    }

    if (!currentKey) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(root[currentKey])) root[currentKey] = [];
      const itemText = trimmed.slice(2).trim();
      const list = root[currentKey] as unknown[];
      if (itemText.includes(": ")) {
        currentObject = {};
        list.push(currentObject);
        const [key, ...rest] = itemText.split(":");
        currentObject[key.trim()] = scalar(rest.join(":").trim());
      } else {
        currentObject = undefined;
        list.push(scalar(itemText));
      }
      continue;
    }

    if (currentObject) {
      const match = /^([^:]+):(.*)$/.exec(trimmed);
      if (match) currentObject[match[1].trim()] = scalar(match[2].trim());
    }
  }

  return root;
}

export function readYamlFile<T>(filePath: string): T {
  return parseSimpleYaml(readFileSync(filePath, "utf8")) as T;
}

function quoteIfNeeded(value: unknown): string {
  if (Array.isArray(value)) return "[]";
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[:#\[\]{}]|^\s|\s$/.test(text) ? JSON.stringify(text) : text;
}

export function stringifySimpleYaml(value: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      lines.push(`${key}:`);
      for (const entry of item) {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          const entries = Object.entries(entry as Record<string, unknown>);
          const [firstKey, firstValue] = entries[0] ?? ["", ""];
          lines.push(`  - ${firstKey}: ${quoteIfNeeded(firstValue)}`);
          for (const [nestedKey, nestedValue] of entries.slice(1)) {
            lines.push(`    ${nestedKey}: ${quoteIfNeeded(nestedValue)}`);
          }
        } else {
          lines.push(`  - ${quoteIfNeeded(entry)}`);
        }
      }
    } else {
      lines.push(`${key}: ${quoteIfNeeded(item)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
