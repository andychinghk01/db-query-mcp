import type { Card } from "./client.js";

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = "", text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function connectionCard(card: Card, open: () => void): HTMLButtonElement {
  const button = element("button", "card");
  const top = element("span", "card-top");
  const postgres = card.type === "postgresql";
  const icon = element("span", `engine ${postgres ? "pg" : "mysql"}`, postgres ? "PG" : "MY");
  icon.setAttribute("aria-label", postgres ? "PostgreSQL" : "MySQL");
  top.append(icon, element("strong", "card-name", card.name));
  if (card.environment) {
    top.append(element("span", `pill ${card.environment}`, card.environment.toUpperCase()));
  }
  const states = { keychain: "🔒 Keychain", plaintext: "⚠ Plaintext", missing: "No password" };
  button.append(top, element("span", "endpoint", `${card.host}:${card.port}`),
    element("span", "card-description", card.description),
    element("span", `password-status ${card.passwordState}`, states[card.passwordState]));
  button.addEventListener("click", open);
  return button;
}
