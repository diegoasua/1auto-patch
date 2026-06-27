import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markRecoveryRecord } from "../src/recovery.js";
import { updatePassword } from "../src/vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ledgerPath = path.join(root, "repair-recovery.local.json");
const query = process.argv.slice(2).join(" ").trim().toLowerCase();

const records = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
const candidates = records
  .filter((record) => {
    if (!record.itemId || !record.newPassword) return false;
    if (record.status === "vault_updated") return false;
    if (!query) return true;
    return [record.itemId, record.title, record.username, record.website]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  })
  .sort((a, b) => new Date(b.updatedAt ?? b.createdAt) - new Date(a.updatedAt ?? a.createdAt));

const record = candidates[0];
if (!record) {
  throw new Error(query ? `No unrecovered record matched "${query}".` : "No unrecovered recovery record found.");
}

process.env.VAULT_PROVIDER = process.env.VAULT_PROVIDER || "1password";
await updatePassword(record.itemId, record.newPassword);
await markRecoveryRecord(record.id, "vault_updated", {
  recoveredAt: new Date().toISOString(),
  recoverySource: "scripts/recover-latest.js",
});

console.log(`Updated 1Password item "${record.title}" from recovery record ${record.id}.`);
console.log("The recovered password was not printed.");
