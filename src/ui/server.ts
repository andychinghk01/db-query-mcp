import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { getConfigPath } from "../config.js";
import { getSecretStore, type SecretStore } from "../secrets.js";
import { handleApi, type TestExecutor } from "./api.js";

const headers = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

type LockHandle = {
  fd: number;
  identity: { dev: number; ino: number };
};

function protectedResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    secured.headers.set(name, value);
  }
  return secured;
}

function acquireLock(path: string): LockHandle {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, "wx", 0o600);
    const identity = fstatSync(fd);
    return { fd, identity: { dev: identity.dev, ino: identity.ino } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("Could not create the UI lock file.");
    }
  }

  const previous = openSync(path, "r");
  try {
    const identity = fstatSync(previous);
    const raw = readFileSync(previous, "utf8");
    const pid = Number(/^\{"pid":([1-9]\d*),"port":\d+\}\n$/.exec(raw)?.[1]);
    if (Number.isInteger(pid) && pid <= 2_147_483_647) {
      try {
        process.kill(pid, 0);
        throw new Error("The local management UI is already running.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw new Error("The local management UI is already running.");
        }
      }
    } else if (Date.now() - identity.mtimeMs < 30_000) {
      throw new Error("The UI lock is being initialized. Try again shortly.");
    }
    const current = statSync(path, { throwIfNoEntry: false });
    if (current?.ino === identity.ino && current.dev === identity.dev) {
      unlinkSync(path);
    }
  } finally {
    closeSync(previous);
  }
  const fd = openSync(path, "wx", 0o600);
  const identity = fstatSync(fd);
  return { fd, identity: { dev: identity.dev, ino: identity.ino } };
}

function removeOwnLock(path: string, identity: { dev: number; ino: number }): void {
  const current = statSync(path, { throwIfNoEntry: false });
  if (current?.dev === identity.dev && current.ino === identity.ino) {
    unlinkSync(path);
  }
}

export async function startUi(options: { port?: number; store?: SecretStore; execute?: TestExecutor; idleMs?: number } = {}): Promise<{
  url: string;
  closed: Promise<void>;
  stop: () => Promise<void>;
}> {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/web/index.html`], sourcemap: "none", throw: false });
  if (!build.success) {
    throw new Error("Could not bundle the local management UI.");
  }
  const assets = new Map(build.outputs.map((asset) => [asset.path.endsWith(".html") ? "/" : `/${basename(asset.path)}`, asset]));
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const store = options.store ?? getSecretStore();
  const lockPath = `${getConfigPath()}.ui.lock`;
  const lock = acquireLock(lockPath);
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  let finish: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (): Promise<void> => {
    if (!stopping) {
      clearTimeout(idle);
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
      stopping = server.stop(false).finally(() => {
        removeOwnLock(lockPath, lock.identity);
        finish();
      });
    }
    return stopping;
  };
  const signal = (): void => {
    void stop();
  };
  const touch = (): void => {
    if (!stopping) {
      clearTimeout(idle);
      idle = setTimeout(signal, options.idleMs ?? 15 * 60_000);
    }
  };
  const quit = (): void => {
    setTimeout(signal, 0);
  };

  const server = (() => {
    try {
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        development: false,
        async fetch(request, runningServer) {
          const { pathname } = new URL(request.url);
          if (pathname.startsWith("/api/")) {
            return protectedResponse(await handleApi(request, pathname, {
              token, port: Number(runningServer.port), store, execute: options.execute, touch, quit,
            }));
          }
          const asset = assets.get(pathname);
          if (asset && (request.method === "GET" || request.method === "HEAD")) {
            return protectedResponse(new Response(request.method === "HEAD" ? null : asset, {
              headers: { "Content-Type": asset.type },
            }));
          }
          return protectedResponse(new Response("Not found.", { status: 404 }));
        },
        error() {
          return protectedResponse(new Response("Request failed.", { status: 500 }));
        },
      });
      try {
        writeFileSync(lock.fd, `${JSON.stringify({ pid: process.pid, port: listener.port })}\n`);
      } catch (error) {
        void listener.stop(true);
        removeOwnLock(lockPath, lock.identity);
        throw error;
      }
      return listener;
    } catch (error) {
      removeOwnLock(lockPath, lock.identity);
      if (error instanceof Error && error.message.startsWith("Could not")) {
        throw error;
      }
      throw new Error(
        "Could not start the local management UI. Check the port and config directory.",
      );
    } finally {
      closeSync(lock.fd);
    }
  })();

  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  touch();
  return { url: `http://127.0.0.1:${server.port}/#t=${token}`, closed, stop };
}
