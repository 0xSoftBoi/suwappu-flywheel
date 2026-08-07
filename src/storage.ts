/**
 * Fail-closed JSON persistence for financial strategy state.
 *
 * Missing state may be initialized. Existing state that cannot be parsed or
 * validated must never be silently replaced with an empty/default ledger.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

export class StateFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`State file ${path} ${reason}; refusing to replace durable state`);
    this.name = "StateFileError";
    this.path = path;
  }
}

export function readJsonFile<T>(
  path: string,
  fallback: () => T,
  validate: (value: unknown) => boolean,
): T {
  if (!existsSync(path)) return fallback();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new StateFileError(path, "contains invalid JSON");
  }
  if (!validate(parsed)) {
    throw new StateFileError(path, "has an unexpected schema");
  }
  return parsed as T;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);

    // Best effort: syncing the containing directory makes the rename durable
    // on filesystems that support directory fsync.
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some platforms do not permit fsync on directories.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
