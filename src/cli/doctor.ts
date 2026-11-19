import { statSync } from "node:fs";
import { getConfigPath, readConfigWithEtag } from "../config.js";
import { getSecretStore } from "../secrets.js";

export async function doctor(store = getSecretStore()): Promise<boolean> {
  console.error(`Bun: ${process.execPath}`);
  const key = `doctor-${crypto.randomUUID()}`;
  const probe = crypto.randomUUID();
  try {
    await store.set(key, probe);
    if (await store.get(key) !== probe) {
      throw new Error("Keychain round trip failed.");
    }
  } finally {
    await store.delete(key);
  }
  console.error("Keychain round trip: OK");
  const { config } = readConfigWithEtag();
  const info = statSync(getConfigPath(), { throwIfNoEntry: false });
  let ok = true;
  if (!info || (info.mode & 0o777) !== 0o600) {
    console.error("Config is missing or not mode 0600.");
    ok = false;
  }
  for (const item of config.connections) {
    const present = await store.get(item.name) !== null;
    const plaintext = item.password === undefined ? "" : "; plaintext password in config";
    console.error(`${JSON.stringify(item.name)}: Keychain ${present ? "present" : "missing"}${plaintext}`);
    ok = ok && present && item.password === undefined;
  }
  return ok;
}
