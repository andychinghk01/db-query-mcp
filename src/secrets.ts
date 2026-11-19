export class KeychainTimeout extends Error {
  constructor() {
    super("Keychain request timed out. Run db-query-mcp doctor in a terminal.");
  }
}

export class KeychainAccessDenied extends Error {
  constructor() {
    super("Keychain access denied. Unlock your Keychain and run db-query-mcp doctor.");
  }
}

export class KeychainUnavailable extends Error {
  constructor() {
    super("Keychain operation failed. Run db-query-mcp doctor in a terminal.");
  }
}

export class SecretMissing extends Error {
  constructor(name: string) {
    super(`No password for connection ${JSON.stringify(name)}. Run db-query-mcp set-password ${JSON.stringify(name)} or migrate.`);
  }
}

export type SecretStore = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
};

export class KeychainSecretStore implements SecretStore {
  private readonly service: string;

  constructor(service = process.env.DB_QUERY_MCP_KEYCHAIN_SERVICE ?? "db-query-mcp") {
    this.service = service;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new KeychainTimeout()), 15_000);
        }),
        operation(),
      ]);
    } catch (error) {
      if (error instanceof KeychainTimeout) {
        throw error;
      }
      if (error instanceof Error && /denied|cancel(?:ed|led)|not allowed|interaction|25293|25308/i.test(error.message)) {
        throw new KeychainAccessDenied();
      }
      throw new KeychainUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  get(name: string): Promise<string | null> {
    return this.run(() => Bun.secrets.get({ service: this.service, name }));
  }

  set(name: string, value: string): Promise<void> {
    return this.run(() => Bun.secrets.set({ service: this.service, name, value }));
  }

  delete(name: string): Promise<boolean> {
    return this.run(() => Bun.secrets.delete({ service: this.service, name }));
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}

let override: SecretStore | undefined;

export function getSecretStore(): SecretStore {
  return override ?? new KeychainSecretStore();
}

export function setSecretStore(store: SecretStore | undefined): void {
  override = store;
}
