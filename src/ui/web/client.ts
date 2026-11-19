import type { ConnectionConfig } from "../../types.js";

export type Card = Omit<ConnectionConfig, "password" | "environment"> & {
  environment: ConnectionConfig["environment"] | null;
  passwordState: "keychain" | "plaintext" | "missing";
};

export type State = {
  connections: Card[];
  configPath: string;
  plaintextCount: number;
  settings: { queryTimeoutMs: number; defaultRowLimit: number };
  etag: string;
};

export type TestResult = { ok: true; latencyMs: number; serverVersion?: string } | { ok: false; error: string };

const token = new URLSearchParams(location.hash.slice(1)).get("t");
history.replaceState(null, "", location.pathname + location.search);
let etag = "";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, method = "GET", body?: object): Promise<T> {
  if (!token) {
    throw new ApiError(401, "Open the URL printed by db-query-mcp ui to start a session.");
  }
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (method !== "GET") {
    headers.set("If-Match", etag);
  }
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json() as { etag?: string; error?: string };
  etag = result.etag ?? etag;
  if (!response.ok) {
    throw new ApiError(response.status, result.error ?? "Request failed.");
  }
  return result as T;
}
