const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const tasksDir = "contracts/tasks";
const files = readdirSync(tasksDir)
  .filter((f) => f.startsWith("SCWBS-") && f.endsWith(".yaml"))
  .sort();

for (const f of files) {
  const taskId = f.replace(/\.yaml$/, "");
  try {
    execFileSync("npm", ["run", "scwbs", "--", "task", "refresh", "--task", taskId, "--apply"], {
      cwd: process.cwd(),
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    console.log(`refreshed ${taskId}`);
  } catch (e) {
    console.error(`FAILED ${taskId}: ${e.message?.slice(0, 200)}`);
  }
}