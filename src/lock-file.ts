import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export class ConfigLocked extends Error {
  constructor() {
    super("Another db-query-mcp process is writing the config. Try again.");
  }
}

type LockIdentity = { dev: number; ino: number };
export type WriteLock = { fd: number; identity: LockIdentity; path: string };

function sameFile(path: string, identity: LockIdentity): boolean {
  const current = statSync(path, { throwIfNoEntry: false });
  return current?.dev === identity.dev && current.ino === identity.ino;
}

function removeIfOwn(path: string, identity: LockIdentity): void {
  if (sameFile(path, identity)) {
    unlinkSync(path);
  }
}

function releaseWriteLock(lock: WriteLock): void {
  try {
    removeIfOwn(lock.path, lock.identity);
  } finally {
    closeSync(lock.fd);
  }
}

function reportReleaseFailure(): void {
  console.error("db-query-mcp: could not remove the config write lock.");
}

export function acquireWriteLock(path: string): WriteLock {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const identity = fstatSync(fd);
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
      } catch (error) {
        try {
          closeSync(fd);
        } finally {
          removeIfOwn(path, { dev: identity.dev, ino: identity.ino });
        }
        throw error;
      }
      return { fd, identity: { dev: identity.dev, ino: identity.ino }, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const current = statSync(path, { throwIfNoEntry: false });
    if (current) {
      let pid = 0;
      try {
        pid = Number(JSON.parse(readFileSync(path, "utf8")).pid);
      } catch {
        pid = 0;
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH" && sameFile(path, current)) {
            unlinkSync(path);
            continue;
          }
        }
      } else if (Date.now() - current.mtimeMs > 5_000 && sameFile(path, current)) {
        unlinkSync(path);
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new ConfigLocked();
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

export function withWriteLock<T>(path: string, operation: () => T): T {
  const lock = acquireWriteLock(path);
  try {
    const result = operation();
    try {
      releaseWriteLock(lock);
    } catch {
      reportReleaseFailure();
    }
    return result;
  } catch (error) {
    try {
      releaseWriteLock(lock);
    } catch {
      reportReleaseFailure();
    }
    throw error;
  }
}
