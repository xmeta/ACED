const { readFileSync, writeFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

const target = "contracts/wbs/project.wbs.json";
const tasksDir = "contracts/tasks";

const files = readdirSync(tasksDir)
  .filter((f) => f.startsWith("SCWBS-") && f.endsWith(".yaml") && f !== "SCWBS-023.yaml")
  .map((f) => path.join(tasksDir, f));

let modified = 0;
let skipped = 0;

for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (content.includes(`  - ${target}`)) {
    skipped++;
    console.log(`SKIP ${file} (already has ${target})`);
    continue;
  }

  const lines = content.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l === "humanGateRequiredPaths:");
  if (startIdx < 0) {
    console.log(`WARN ${file} has no humanGateRequiredPaths block`);
    continue;
  }

  let lastEntryIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("  - ")) {
      lastEntryIdx = i;
    } else if (lines[i].trim() === "") {
      continue;
    } else {
      break;
    }
  }

  lines.splice(lastEntryIdx + 1, 0, `  - ${target}`);
  // preserve original line ending style
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, lines.join(eol), "utf8");
  modified++;
  console.log(`MOD  ${file}`);
}

console.log(`\nDone: ${modified} modified, ${skipped} skipped`);