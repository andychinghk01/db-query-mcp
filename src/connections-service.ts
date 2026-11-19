import { ConfigConflictError, readConfigBytes, readConfigWithEtag, restoreConfigBytes, saveConfig } from "./config.js";
import { KeychainTimeout, getSecretStore, type SecretStore } from "./secrets.js";
import type { ConnectionConfig, ServerConfig } from "./types.js";

export class ConnectionNotFound extends Error {
  constructor() {
    super("Connection not found.");
  }
}

export class ConnectionExists extends Error {
  constructor() {
    super("Connection name already exists.");
  }
}

export class PartialWriteError extends Error {
  readonly cause: unknown;
  readonly compensationErrors: unknown[];

  constructor(step: string, state: string, cause: unknown, compensationErrors: unknown[]) {
    super(`${step} failed; ${state}. Run db-query-mcp doctor.`);
    this.name = "PartialWriteError";
    this.cause = cause;
    this.compensationErrors = compensationErrors;
  }
}

export function requireCurrent(ifMatch?: string): ReturnType<typeof readConfigWithEtag> {
  const snapshot = readConfigWithEtag();
  if (ifMatch !== undefined && ifMatch !== snapshot.etag) {
    throw new ConfigConflictError(snapshot.etag);
  }
  return snapshot;
}

export function findConnection(config: ServerConfig, name: string): ConnectionConfig {
  const connection = config.connections.find((item) => item.name === name);
  if (!connection) {
    throw new ConnectionNotFound();
  }
  return connection;
}

function requireFree(config: ServerConfig, name: string): void {
  if (config.connections.some((connection) => connection.name === name)) {
    throw new ConnectionExists();
  }
}

async function restoreSecret(store: SecretStore, name: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await store.delete(name);
  } else {
    await store.set(name, previous);
  }
  const current = await store.get(name);
  if (current !== previous) {
    throw new Error(`Secret state mismatch for ${JSON.stringify(name)}.`);
  }
}

function unknownSecretError(step: string, cause: unknown, compensationErrors: unknown[] = []): PartialWriteError {
  const state = "secret state is UNKNOWN; run db-query-mcp doctor, then " +
    "set-password <name> if it reports a missing secret";
  return new PartialWriteError(step, state, cause, compensationErrors);
}

export async function stagedWrite(
  store: SecretStore,
  name: string,
  value: string | undefined,
  write: () => string,
): Promise<string> {
  if (value === undefined) {
    return write();
  }
  const previous = await store.get(name);
  try {
    await store.set(name, value);
  } catch (error) {
    if (error instanceof KeychainTimeout) {
      throw unknownSecretError("Secret write", error);
    }
    try {
      await restoreSecret(store, name, previous);
    } catch (compensationError) {
      throw new PartialWriteError("Secret write", `secret ${JSON.stringify(name)} may be inconsistent`, error, [compensationError]);
    }
    throw error;
  }
  try {
    return write();
  } catch (error) {
    try {
      await restoreSecret(store, name, previous);
    } catch (compensationError) {
      throw new PartialWriteError("Config write", `secret ${JSON.stringify(name)} may be inconsistent`, error, [compensationError]);
    }
    throw error;
  }
}

let pending: Promise<unknown> = Promise.resolve();

export function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

export function createConnection(
  connection: ConnectionConfig,
  password: string | undefined,
  ifMatch: string,
  store = getSecretStore(),
): Promise<string> {
  return serializeWrite(async () => {
    const { config } = requireCurrent(ifMatch);
    requireFree(config, connection.name);
    return stagedWrite(store, connection.name, password, () => saveConfig({
      ...config,
      connections: [...config.connections, { ...connection, password: undefined }],
    }, { ifMatch }));
  });
}

export function updateConnection(
  name: string,
  connection: ConnectionConfig,
  password: string | undefined,
  ifMatch: string,
  store = getSecretStore(),
): Promise<string> {
  return serializeWrite(async () => {
    const { config, etag } = requireCurrent(ifMatch);
    const snapshot = readConfigBytes();
    if (snapshot.etag !== etag) {
      throw new ConfigConflictError(snapshot.etag);
    }
    const old = findConnection(config, name);
    const rename = name !== connection.name;
    if (rename) {
      requireFree(config, connection.name);
    }
    const previousNew = rename ? await store.get(connection.name) : null;
    const previousOld = rename ? await store.get(name) : null;
    const secret = password ?? (rename ? old.password ?? previousOld ?? undefined : undefined);
    const next = { ...connection, password: secret === undefined ? old.password : undefined };
    if (rename && secret !== undefined) {
      try {
        await store.set(next.name, secret);
      } catch (error) {
        if (error instanceof KeychainTimeout) {
          throw unknownSecretError("Rename secret write", error);
        }
        try {
          await restoreSecret(store, next.name, previousNew);
        } catch (compensationError) {
          throw new PartialWriteError("Rename secret write", "new secret may be inconsistent", error, [compensationError]);
        }
        throw error;
      }
    }
    let newEtag: string;
    try {
      newEtag = rename ? saveConfig({
        ...config,
        connections: config.connections.map((item) => item === old ? next : item),
      }, { ifMatch, renamed: new Map([[next.name, name]]) }) : await stagedWrite(store, next.name, secret, () => saveConfig({
        ...config,
        connections: config.connections.map((item) => item === old ? next : item),
      }, { ifMatch, renamed: new Map([[next.name, name]]) }));
    } catch (error) {
      if (rename && secret !== undefined) {
        try {
          await restoreSecret(store, next.name, previousNew);
        } catch (compensationError) {
          throw new PartialWriteError("Rename config write", "new secret may be inconsistent", error, [compensationError]);
        }
      }
      throw error;
    }
    if (!rename) {
      return newEtag;
    }
    try {
      await store.delete(name);
    } catch (error) {
      const compensationErrors: unknown[] = [];
      try {
        restoreConfigBytes(snapshot.bytes, newEtag);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (error instanceof KeychainTimeout) {
        throw unknownSecretError("Old secret deletion", error, compensationErrors);
      }
      try {
        if (secret !== undefined) {
          await restoreSecret(store, next.name, previousNew);
        }
        await restoreSecret(store, name, previousOld);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new PartialWriteError("Old secret deletion", "config or secrets may be inconsistent", error, compensationErrors);
      }
      throw error;
    }
    return newEtag;
  });
}

export function deleteConnection(name: string, ifMatch: string, store = getSecretStore()): Promise<string> {
  return serializeWrite(async () => {
    const { config, etag } = requireCurrent(ifMatch);
    const snapshot = readConfigBytes();
    if (snapshot.etag !== etag) {
      throw new ConfigConflictError(snapshot.etag);
    }
    findConnection(config, name);
    const previous = await store.get(name);
    const newEtag = saveConfig({
      ...config,
      connections: config.connections.filter((connection) => connection.name !== name),
    }, { ifMatch });
    try {
      await store.delete(name);
    } catch (error) {
      const compensationErrors: unknown[] = [];
      try {
        restoreConfigBytes(snapshot.bytes, newEtag);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (error instanceof KeychainTimeout) {
        throw unknownSecretError("Secret deletion", error, compensationErrors);
      }
      try {
        await restoreSecret(store, name, previous);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new PartialWriteError("Secret deletion", "config or secret may be inconsistent", error, compensationErrors);
      }
      throw error;
    }
    return newEtag;
  });
}

export function changePassword(
  name: string,
  password: string | undefined,
  ifMatch?: string,
  store = getSecretStore(),
): Promise<string> {
  if (password !== undefined) {
    return serializeWrite(async () => {
      const { config, etag } = requireCurrent(ifMatch);
      const connection = findConnection(config, name);
      return stagedWrite(store, name, password, () => saveConfig({
        ...config,
        connections: config.connections.map((item) => item === connection ? { ...item, password: undefined } : item),
      }, { ifMatch: etag }));
    });
  }
  return serializeWrite(async () => {
    const { config, etag } = requireCurrent(ifMatch);
    const snapshot = readConfigBytes();
    if (snapshot.etag !== etag) {
      throw new ConfigConflictError(snapshot.etag);
    }
    const connection = findConnection(config, name);
    const previous = await store.get(name);
    const nextEtag = saveConfig({
      ...config,
      connections: config.connections.map((item) => item === connection ? { ...item, password: undefined } : item),
    }, { ifMatch: etag });
    try {
      await store.delete(name);
    } catch (error) {
      const compensationErrors: unknown[] = [];
      try {
        restoreConfigBytes(snapshot.bytes, nextEtag);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (error instanceof KeychainTimeout) {
        throw unknownSecretError("Password deletion", error, compensationErrors);
      }
      try {
        await restoreSecret(store, name, previous);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new PartialWriteError("Password deletion", "config or secret may be inconsistent", error, compensationErrors);
      }
      throw error;
    }
    return nextEtag;
  });
}
