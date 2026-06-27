import { chromium } from "playwright";
import { repairWithDaytonaBrowser } from "./daytona-browser.js";
import { generatePassword } from "./password.js";
import { createRecoveryRecord, markRecoveryRecord } from "./recovery.js";
import { updatePassword } from "./vault.js";

export async function repairPassword(item, adapter) {
  const newPassword = generatePassword();
  const events = [];
  const log = (message) => events.push({ at: new Date().toISOString(), message });
  const recovery = await createRecoveryRecord({
    item,
    oldPassword: item.password,
    newPassword,
    runtime: process.env.REPAIR_RUNTIME ?? "local",
    adapter: adapter.id,
  });

  if (process.env.REPAIR_RUNTIME === "daytona") {
    try {
      log("Starting Daytona browser repair run");
      const result = await repairWithDaytonaBrowser(item, newPassword, adapter);
      for (const event of result.events ?? []) events.push(event);
      log("Daytona browser verified password change");
      await markRecoveryRecord(recovery.id, "site_changed");
      const updated = await updatePassword(item.id, newPassword);
      await markRecoveryRecord(recovery.id, "vault_updated");
      log("Vault item updated after sandbox confirmation");
      return { ok: true, item: redact(updated), events, runtime: "daytona-browser", adapter: adapter.id };
    } catch (error) {
      await markRecoveryRecord(recovery.id, "failed", { error: error.message });
      log(`Daytona repair failed: ${error.message}`);
      return { ok: false, error: error.message, events, runtime: "daytona-browser", adapter: adapter.id };
    }
  }

  log("Starting isolated browser session");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    log(`Opening login page for ${item.title}`);
    await page.goto(item.website, { waitUntil: "networkidle" });
    await page.fill("input[name=email]", item.username);
    await page.fill("input[name=password]", item.password);
    await page.click("button[type=submit]");
    await page.waitForURL("**/target/settings");

    log("Authenticated; opening password settings");
    await page.goto(item.changePasswordUrl, { waitUntil: "networkidle" });
    await page.fill("input[name=currentPassword]", item.password);
    await page.fill("input[name=newPassword]", newPassword);
    await page.fill("input[name=confirmPassword]", newPassword);
    await page.click("button[type=submit]");
    await page.waitForSelector("[data-testid=success]");

    log("Website confirmed password change");
    await markRecoveryRecord(recovery.id, "site_changed");
    const updated = await updatePassword(item.id, newPassword);
    await markRecoveryRecord(recovery.id, "vault_updated");
    log("Vault item updated after confirmation");
    return { ok: true, item: redact(updated), events, adapter: adapter.id };
  } catch (error) {
    await markRecoveryRecord(recovery.id, "failed", { error: error.message });
    log(`Repair failed: ${error.message}`);
    return { ok: false, error: error.message, events, adapter: adapter.id };
  } finally {
    await browser.close();
  }
}

function redact(item) {
  return {
    ...item,
    password: `${item.password.slice(0, 4)}...${item.password.slice(-4)}`,
  };
}
