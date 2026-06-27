import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getOnePasswordItem,
  listOnePasswordItems,
  updateOnePasswordPassword,
} from "./onepassword.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const localVaultPath = path.join(root, "vault.local.json");
const seedVaultPath = path.join(root, "data", "demo-vault.json");

async function ensureLocalVault() {
  try {
    await fs.access(localVaultPath);
  } catch {
    await fs.copyFile(seedVaultPath, localVaultPath);
  }
}

export async function listItems() {
  if (process.env.VAULT_PROVIDER === "1password") {
    return listOnePasswordItems();
  }
  await ensureLocalVault();
  const raw = await fs.readFile(localVaultPath, "utf8");
  return JSON.parse(raw);
}

export async function getItem(id) {
  if (process.env.VAULT_PROVIDER === "1password") {
    return getOnePasswordItem(id);
  }
  const items = await listItems();
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown vault item: ${id}`);
  return item;
}

export async function updatePassword(id, password) {
  if (process.env.VAULT_PROVIDER === "1password") {
    return updateOnePasswordPassword(id, password);
  }
  const items = await listItems();
  const idx = items.findIndex((candidate) => candidate.id === id);
  if (idx === -1) throw new Error(`Unknown vault item: ${id}`);
  items[idx] = {
    ...items[idx],
    password,
    updatedAt: new Date().toISOString(),
    tags: [...new Set([...(items[idx].tags ?? []), "autopatched"])],
  };
  await fs.writeFile(localVaultPath, JSON.stringify(items, null, 2) + "\n");
  return items[idx];
}

export async function resetVault() {
  await fs.copyFile(seedVaultPath, localVaultPath);
  return listItems();
}
