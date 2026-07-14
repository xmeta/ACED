import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AtomicFileWrite = {
  path: string;
  content: string;
};

export type AtomicWriteOptions = {
  beforeCommit?: (index: number, file: AtomicFileWrite) => void;
  journalPath?: string;
};

type AtomicWriteJournal = {
  schemaVersion: "1.0.0";
  files: Array<{ path: string; existed: boolean; previous?: string }>;
};

function removeIfPresent(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}

function restoreJournal(journal: AtomicWriteJournal): string[] {
  for (const file of journal.files) {
    if (file.existed) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.previous ?? "", "utf8");
    } else {
      removeIfPresent(file.path);
    }
  }
  return journal.files.map((file) => file.path);
}

export function recoverAtomicFileWrites(journalPath: string, allowedPaths?: string[]): string[] {
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as AtomicWriteJournal;
  if (journal.schemaVersion !== "1.0.0" || !Array.isArray(journal.files)) {
    throw new Error(`Invalid atomic write journal: ${journalPath}`);
  }
  if (allowedPaths) {
    const allowed = new Set(allowedPaths.map((file) => path.resolve(file)));
    const unexpected = journal.files.find((file) => !allowed.has(path.resolve(file.path)));
    if (unexpected) throw new Error(`Atomic write journal contains an unexpected path: ${unexpected.path}`);
  }
  const restored = restoreJournal(journal);
  removeIfPresent(journalPath);
  return restored;
}

/**
 * Stage every file beside its destination, then replace the destinations as a
 * single rollback unit. If staging or a replacement step throws, restore every
 * pre-existing byte-for-byte snapshot and remove newly-created destinations.
 */
export function writeFilesAtomically(files: AtomicFileWrite[], options: AtomicWriteOptions = {}): string[] {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = files.map((file, index) => {
    mkdirSync(path.dirname(file.path), { recursive: true });
    const tempPath = `${file.path}.scwbs-${token}-${index}.tmp`;
    writeFileSync(tempPath, file.content, "utf8");
    return {
      ...file,
      tempPath,
      existed: existsSync(file.path),
      previous: existsSync(file.path) ? readFileSync(file.path, "utf8") : undefined
    };
  });
  const committed: typeof staged = [];
  try {
    if (options.journalPath) {
      mkdirSync(path.dirname(options.journalPath), { recursive: true });
      const journal: AtomicWriteJournal = {
        schemaVersion: "1.0.0",
        files: staged.map(({ path: filePath, existed, previous }) => ({
          path: filePath,
          existed,
          ...(previous !== undefined ? { previous } : {})
        }))
      };
      const journalTemp = `${options.journalPath}.${token}.tmp`;
      writeFileSync(journalTemp, `${JSON.stringify(journal)}\n`, "utf8");
      renameSync(journalTemp, options.journalPath);
    }
    staged.forEach((file, index) => {
      options.beforeCommit?.(index, file);
      renameSync(file.tempPath, file.path);
      committed.push(file);
    });
    return files.map((file) => file.path);
  } catch (error) {
    for (const file of committed.reverse()) {
      if (file.existed) writeFileSync(file.path, file.previous ?? "", "utf8");
      else removeIfPresent(file.path);
    }
    if (options.journalPath) removeIfPresent(options.journalPath);
    throw error;
  } finally {
    for (const file of staged) removeIfPresent(file.tempPath);
    if (committed.length === staged.length && options.journalPath) removeIfPresent(options.journalPath);
  }
}
