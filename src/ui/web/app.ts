import { ApiError, request, type Card, type State, type TestResult } from "./client.js";
import { byId, connectionCard, element } from "./dom.js";

let state: State | undefined;
let editing: Card | undefined;
let dirty = false;
let busy = false;
let conflicted = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const cards = byId<HTMLDivElement>("cards");
const editor = byId<HTMLDialogElement>("editor");
const form = byId<HTMLFormElement>("form");
const search = byId<HTMLInputElement>("search");
const feedback = byId<HTMLParagraphElement>("editor-feedback");

function toast(message: string): void {
  const node = byId<HTMLDivElement>("toast");
  node.textContent = message;
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 3_500);
}

function value(id: string): string {
  return byId<HTMLInputElement | HTMLSelectElement>(id).value;
}

function markDirty(): void {
  dirty = true;
}

function setField(id: string, field: string | number | undefined): void {
  byId<HTMLInputElement | HTMLSelectElement>(id).value = field === undefined ? "" : String(field);
}

function databases(): { name: string; description: string }[] {
  return [...byId<HTMLDivElement>("databases").querySelectorAll(".database-row")].map((row) => ({
    name: (row.querySelector("input[data-field=name]") as HTMLInputElement).value,
    description: (row.querySelector("input[data-field=description]") as HTMLInputElement).value,
  }));
}

function addDatabase(name = "", description = ""): void {
  const row = element("div", "database-row");
  const nameInput = element("input") as HTMLInputElement;
  nameInput.dataset.field = "name";
  nameInput.placeholder = "Database name";
  nameInput.value = name;
  nameInput.setAttribute("aria-label", "Database name");
  const descriptionInput = element("input") as HTMLInputElement;
  descriptionInput.dataset.field = "description";
  descriptionInput.placeholder = "Description";
  descriptionInput.value = description;
  descriptionInput.setAttribute("aria-label", "Database description");
  const remove = element("button", "icon-button", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove database");
  remove.addEventListener("click", () => {
    row.remove();
    markDirty();
  });
  row.append(nameInput, descriptionInput, remove);
  byId<HTMLDivElement>("databases").append(row);
  nameInput.addEventListener("input", markDirty);
  descriptionInput.addEventListener("input", markDirty);
}

function formData(): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: value("name"), description: value("description"), type: value("engine"),
    host: value("host"), port: Number(value("port")), username: value("username"), databases: databases(),
  };
  const environment = value("environment");
  if (environment) {
    result.environment = environment;
  }
  const password = value("password");
  if (password) {
    result.password = password;
  }
  return result;
}

function closeEditor(force = false): void {
  if (!force && dirty && !window.confirm("Discard unsaved changes?")) {
    return;
  }
  setField("password", "");
  editor.close();
  editing = undefined;
  dirty = false;
}

function openEditor(card?: Card): void {
  editing = card;
  const storedPassword = card?.passwordState === "keychain";
  editor.classList.toggle("prod", card?.environment === "prod");
  byId<HTMLButtonElement>("delete").hidden = !card;
  byId<HTMLLabelElement>("password-field").hidden = storedPassword;
  byId<HTMLSpanElement>("test-result").textContent = "";
  setField("confirmation", "");
  byId<HTMLButtonElement>("confirm-delete").disabled = true;
  byId<HTMLHeadingElement>("editor-title").textContent = card ? "Edit connection" : "New connection";
  byId<HTMLParagraphElement>("editor-kicker").textContent = card?.environment === "prod" ? "PRODUCTION CONNECTION" : "CONNECTION";
  setField("name", card?.name);
  setField("description", card?.description);
  setField("engine", card?.type ?? "mysql");
  setField("host", card?.host);
  setField("port", card?.port ?? 3306);
  setField("username", card?.username);
  setField("environment", card?.environment ?? "");
  byId<HTMLInputElement>("password").value = "";
  const plaintext = card?.passwordState === "plaintext";
  byId("password-state").textContent = storedPassword
    ? "🔒 Stored in Keychain. Passwords are write-only."
    : plaintext ? "⚠ Stored in plaintext. Enter a replacement or use the migration banner." : "No password stored yet.";
  byId("replace").hidden = !storedPassword;
  byId("remove-password").hidden = !storedPassword && !plaintext;
  byId<HTMLDivElement>("delete-confirm").hidden = true;
  byId<HTMLParagraphElement>("editor-feedback").textContent = "";
  const databaseList = byId<HTMLDivElement>("databases");
  databaseList.replaceChildren();
  (card?.databases ?? [{ name: "", description: "" }]).forEach((database) => addDatabase(database.name, database.description));
  dirty = false;
  editor.showModal();
  byId<HTMLInputElement>("name").focus();
}

function render(): void {
  if (!state) {
    return;
  }
  const query = search.value.toLowerCase().trim();
  cards.replaceChildren();
  const filtered = state.connections.filter((card) => `${card.name} ${card.description} ${card.host}`.toLowerCase().includes(query));
  filtered.forEach((card) => cards.append(connectionCard(card, () => openEditor(card))));
  byId<HTMLParagraphElement>("count").textContent = `${filtered.length} ${filtered.length === 1 ? "CONNECTION" : "CONNECTIONS"}`;
  const empty = byId<HTMLParagraphElement>("empty");
  empty.hidden = filtered.length > 0;
  empty.textContent = state.connections.length === 0
    ? "Your workspace is empty. Add your first database connection to get started."
    : "No connections match your search.";
  byId<HTMLDivElement>("legacy").hidden = state.plaintextCount === 0;
  const passwordCount = state.plaintextCount === 1 ? "" : "s";
  byId<HTMLButtonElement>("migrate").textContent =
    `Move ${state.plaintextCount} password${passwordCount} to Keychain`;
  byId<HTMLElement>("settings").textContent =
    `Query timeout ${state.settings.queryTimeoutMs}ms · Row limit ${state.settings.defaultRowLimit} · ` +
    state.configPath;
}

async function load(): Promise<void> {
  state = await request<State>("state");
  byId<HTMLButtonElement>("add").disabled = false;
  byId<HTMLButtonElement>("quit").disabled = false;
  render();
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const payload = formData();
  try {
    if (editing) {
      await request(`connections/${encodeURIComponent(editing.name)}`, "PUT", { ...payload, newName: payload.name });
    } else {
      await request("connections", "POST", payload);
    }
    closeEditor(true);
    toast("Connection saved");
    await load();
  } catch (error) {
    showError(error);
  }
}

async function testConnection(): Promise<void> {
  const result = byId<HTMLSpanElement>("test-result");
  result.textContent = "Testing…";
  try {
    const test: TestResult = editing && !value("password")
      ? await request<TestResult>("test", "POST", { name: editing.name, useStored: true })
      : await request<TestResult>("test", "POST", formData());
    result.textContent = test.ok ? `Connected in ${test.latencyMs}ms${test.serverVersion ? ` · ${test.serverVersion}` : ""}` : test.error;
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Test failed.";
  }
}

async function remove(): Promise<void> {
  if (!editing) {
    return;
  }
  if (editing.environment === "prod") {
    byId<HTMLElement>("delete-name").textContent = editing.name;
    byId<HTMLDivElement>("delete-confirm").hidden = false;
    return;
  }
  if (window.confirm(`Delete ${editing.name}?`)) {
    await deleteConnection();
  }
}

async function deleteConnection(): Promise<void> {
  if (!editing) {
    return;
  }
  try {
    await request(`connections/${encodeURIComponent(editing.name)}`, "DELETE");
    toast("Connection deleted");
    closeEditor(true);
    await load();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Delete failed.";
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : "Request failed.";
  if (error instanceof ApiError && error.status === 409) {
    conflicted = true;
    byId("conflict").hidden = false;
    byId("editor-conflict").hidden = false;
  }
  if (editor.open) {
    feedback.textContent = message;
  } else {
    toast(message);
  }
}

async function run(action: () => Promise<void>, allowConflict = false): Promise<void> {
  if (busy || (conflicted && !allowConflict)) {
    return;
  }
  busy = true;
  try {
    await action();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
  }
}

async function reload(): Promise<void> {
  if (editor.open && dirty && !window.confirm("Discard unsaved changes and reload?")) {
    return;
  }
  await load();
  if (editor.open) {
    closeEditor(true);
  }
  conflicted = false;
  byId("conflict").hidden = true;
  byId("editor-conflict").hidden = true;
}

function bind(): void {
  const on = (id: string, handler: () => void): void => byId(id).addEventListener("click", handler);
  on("add", () => openEditor());
  on("quit", () => void run(async () => {
    await request("quit", "POST");
    byId<HTMLButtonElement>("quit").disabled = true;
    byId<HTMLButtonElement>("add").disabled = true;
    cards.replaceChildren();
    byId("legacy").hidden = true;
    byId("count").textContent = "SESSION ENDED";
    toast("Server stopped. You can close this tab.");
  }));
  on("reload", () => void run(reload, true));
  on("editor-reload", () => void run(reload, true));
  on("migrate", () => void run(async () => {
    await request("migrate", "POST");
    await load();
    toast("Passwords moved to Keychain");
  }));
  on("close", () => closeEditor());
  on("cancel", () => closeEditor());
  on("test", () => void run(testConnection));
  on("delete", () => void run(remove));
  on("confirm-delete", () => {
    if (value("confirmation") === editing?.name) {
      void run(deleteConnection);
    }
  });
  on("abort-delete", () => {
    byId("delete-confirm").hidden = true;
    byId("delete").focus();
  });
  byId("confirmation").addEventListener("input", () => {
    byId<HTMLButtonElement>("confirm-delete").disabled = value("confirmation") !== editing?.name;
  });
  on("replace", () => {
    byId("password-field").hidden = false;
    byId("replace").hidden = true;
    byId("password").focus();
  });
  on("remove-password", () => void run(async () => {
    if (editing && window.confirm("Remove the stored password?")) {
      await request(`connections/${encodeURIComponent(editing.name)}/password`, "DELETE");
      closeEditor(true);
      await load();
      toast("Password removed");
    }
  }));
  on("add-db", () => {
    addDatabase();
    markDirty();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(() => save(event));
  });
  search.addEventListener("input", () => {
    if (!byId<HTMLButtonElement>("add").disabled) {
      render();
    }
  });
  form.addEventListener("input", (event) => {
    if (event.target !== byId("confirmation")) {
      markDirty();
    }
    if (event.target === byId("environment")) {
      const prod = value("environment") === "prod";
      editor.classList.toggle("prod", prod);
      byId("editor-kicker").textContent = prod ? "PRODUCTION CONNECTION" : "CONNECTION";
    }
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "Escape" && editor.open) {
      event.preventDefault();
      closeEditor();
    } else if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey) && editor.open) {
      event.preventDefault();
      form.requestSubmit();
    } else if (!typing && !editor.open && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "/") {
        event.preventDefault();
        search.focus();
      } else if (event.key.toLowerCase() === "n" && !byId<HTMLButtonElement>("add").disabled) {
        event.preventDefault();
        openEditor();
      }
    }
  });
  editor.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditor();
  });
}

bind();
void load().catch((error: unknown) => {
  const empty = byId("empty");
  empty.hidden = false;
  empty.textContent = error instanceof Error ? error.message : "Could not load connections.";
});
