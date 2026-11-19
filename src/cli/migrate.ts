import { ConfigConflictError, readConfigBytes, saveConfig } from "../config.js";
import { PartialWriteError, requireCurrent, serializeWrite } from "../connections-service.js";
import { getSecretStore, KeychainTimeout, SecretMissing, type SecretStore } from "../secrets.js";

async function restoreWritten(
  store: SecretStore,
  previous: ReadonlyMap<string, string | null>,
  names: readonly string[],
  skip: string | undefined = undefined,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const name of [...names].reverse()) {
    if (name === skip) {
      continue;
    }
    try {
      const value = previous.get(name);
      if (value === null || value === undefined) {
        await store.delete(name);
      } else {
        await store.set(name, value);
      }
      if (await store.get(name) !== value) {
        errors.push(new Error(`Secret state mismatch for ${JSON.stringify(name)}.`));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function migrate(
  options: { dryRun?: boolean; revert?: boolean; ifMatch?: string } = {},
  store = getSecretStore(),
): Promise<{ etag: string; names: string[] }> {
  return serializeWrite(async () => {
    const { config, etag } = requireCurrent(options.ifMatch);
    const snapshot = readConfigBytes();
    if (snapshot.etag !== etag) {
      throw new ConfigConflictError(snapshot.etag);
    }
    const targets = config.connections.filter((item) => options.revert ? item.password === undefined : item.password !== undefined);
    const names = targets.map((item) => item.name);
    if (options.dryRun || targets.length === 0) {
      return { etag, names };
    }
    if (options.revert) {
      const restored = new Map<string, string>();
      for (const item of targets) {
        const password = await store.get(item.name);
        if (password === null) {
          throw new SecretMissing(item.name);
        }
        restored.set(item.name, password);
      }
      return {
        names,
        etag: saveConfig({
          ...config,
          connections: config.connections.map((item) => ({
            ...item,
            password: item.password ?? restored.get(item.name),
          })),
        }, { ifMatch: etag }),
      };
    }
    const previous = new Map<string, string | null>();
    const written: string[] = [];
    let inFlight: string | undefined;
    try {
      for (const item of targets) {
        previous.set(item.name, await store.get(item.name));
      }
      const current = readConfigBytes();
      if (current.etag !== etag) {
        throw new ConfigConflictError(current.etag);
      }
      for (const item of targets) {
        if (item.password === undefined) {
          continue;
        }
        written.push(item.name);
        inFlight = item.name;
        await store.set(item.name, item.password);
        inFlight = undefined;
        if (await store.get(item.name) !== item.password) {
          throw new Error("Keychain verification failed. The config was not changed; run db-query-mcp doctor.");
        }
      }
      return {
        names,
        etag: saveConfig({
          ...config,
          connections: config.connections.map((item) => ({ ...item, password: undefined })),
        }, { ifMatch: etag }),
      };
    } catch (error) {
      const compensationErrors = await restoreWritten(
        store,
        previous,
        written,
        error instanceof KeychainTimeout ? inFlight : undefined,
      );
      if (error instanceof KeychainTimeout) {
        const state = "secret state is UNKNOWN; run db-query-mcp doctor, then " +
          "set-password <name> if it reports a missing secret";
        throw new PartialWriteError("Migration secret write", state, error, compensationErrors);
      }
      if (compensationErrors.length > 0) {
        throw new PartialWriteError("Migration rollback", "secrets may be inconsistent", error, compensationErrors);
      }
      throw error;
    }
  });
}
