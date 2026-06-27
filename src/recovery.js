import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recoveryPath = path.join(__dirname, "..", "repair-recovery.local.json");

export async function createRecoveryRecord({ item, oldPassword, newPassword, runtime, adapter }) {
  const record = {
    id: `${Date.now()}-${item.id}`,
    itemId: item.id,
    title: item.title,
    website: item.website,
    username: item.username,
    oldPassword,
    newPassword,
    runtime,
    adapter,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const records = await readRecords();
  records.push(record);
  await writeRecords(records);
  return record;
}

export async function markRecoveryRecord(id, status, extra = {}) {
  const records = await readRecords();
  const idx = records.findIndex((record) => record.id === id);
  if (idx === -1) return;
  records[idx] = {
    ...records[idx],
    ...extra,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeRecords(records);
}

async function readRecords() {
  try {
    return JSON.parse(await fs.readFile(recoveryPath, "utf8"));
  } catch {
    return [];
  }
}

async function writeRecords(records) {
  await fs.writeFile(recoveryPath, JSON.stringify(records, null, 2) + "\n");
}
