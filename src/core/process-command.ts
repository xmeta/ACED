export function resolveSpawnCommand(command: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [...command];

  const [executable, ...args] = command;
  if (executable === "npm") return ["npm.cmd", ...args];
  if (executable === "gh") return ["gh.exe", ...args];
  return [...command];
}
