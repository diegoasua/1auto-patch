import { chromium } from "playwright";
import { repairDemoInDaytona } from "./daytona.js";
import { generatePassword } from "./password.js";
import { updatePassword } from "./vault.js";

export async function repairPassword(item) {
  const newPassword = generatePassword();
  const events = [];
  const log = (message) => events.push({ at: new Date().toISOString(), message });

  if (process.env.REPAIR_RUNTIME === "daytona") {
    try {
      log("Starting Daytona sandbox repair run");
      await repairDemoInDaytona(item, newPassword);
      log("Daytona sandbox confirmed password change");
      const updated = await updatePassword(item.id, newPassword);
      log("Vault item updated after sandbox confirmation");
      return { ok: true, item: redact(updated), events, runtime: "daytona" };
    } catch (error) {
      log(`Daytona repair failed: ${error.message}`);
      return { ok: false, error: error.message, events, runtime: "daytona" };
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
    const updated = await updatePassword(item.id, newPassword);
    log("Vault item updated after confirmation");
    return { ok: true, item: redact(updated), events };
  } catch (error) {
    log(`Repair failed: ${error.message}`);
    return { ok: false, error: error.message, events };
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
