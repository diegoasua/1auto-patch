import { Daytona, CodeLanguage } from "@daytona/sdk";

export function daytonaStatus() {
  const configured = Boolean(process.env.DAYTONA_API_KEY || process.env.DAYTONA_JWT_TOKEN);
  return {
    configured,
    runtimeEnabled: process.env.REPAIR_RUNTIME === "daytona",
    target: process.env.DAYTONA_TARGET ?? "default",
    apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    publicBaseUrl: process.env.DAYTONA_PUBLIC_BASE_URL ?? null,
    message: configured
      ? "Daytona SDK credentials detected."
      : "Set DAYTONA_API_KEY to run repair code in a Daytona sandbox.",
  };
}

export async function probeDaytona() {
  const sandbox = await createSandbox();
  try {
    const response = await sandbox.process.codeRun(`
      console.log(JSON.stringify({
        ok: true,
        runtime: "daytona",
        node: process.version,
        cwd: process.cwd()
      }))
    `);
    return parseSandboxJson(response.result);
  } finally {
    await stopSandbox(sandbox);
  }
}

export async function repairDemoInDaytona(item, newPassword) {
  if (!process.env.DAYTONA_PUBLIC_BASE_URL) {
    throw new Error("DAYTONA_PUBLIC_BASE_URL is required because Daytona cannot reach this app's localhost.");
  }

  const sandbox = await createSandbox({
    TARGET_BASE_URL: process.env.DAYTONA_PUBLIC_BASE_URL,
    ITEM_USERNAME: item.username,
    ITEM_PASSWORD: item.password,
    NEW_PASSWORD: newPassword,
  });

  try {
    const response = await sandbox.process.codeRun(`
      const base = process.env.TARGET_BASE_URL.replace(/\\/$/, "");
      const form = (value) => new URLSearchParams(value).toString();

      const login = await fetch(base + "/target/login", {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        redirect: "manual",
        body: form({email: process.env.ITEM_USERNAME, password: process.env.ITEM_PASSWORD})
      });

      if (![302, 303].includes(login.status)) {
        throw new Error("Login failed inside Daytona sandbox: HTTP " + login.status);
      }

      const change = await fetch(base + "/target/settings", {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: form({
          currentPassword: process.env.ITEM_PASSWORD,
          newPassword: process.env.NEW_PASSWORD,
          confirmPassword: process.env.NEW_PASSWORD
        })
      });

      const html = await change.text();
      if (!change.ok || !html.includes("Password changed")) {
        throw new Error("Password change failed inside Daytona sandbox: HTTP " + change.status);
      }

      console.log(JSON.stringify({ok: true, runtime: "daytona", changed: true}));
    `);
    return parseSandboxJson(response.result);
  } finally {
    await stopSandbox(sandbox);
  }
}

async function createSandbox(envVars = {}) {
  const daytona = new Daytona();
  return daytona.create({
    language: CodeLanguage.JAVASCRIPT,
    ephemeral: true,
    autoStopInterval: 5,
    labels: {
      app: "credential-autopatch",
      purpose: "password-repair",
    },
    envVars,
  });
}

async function stopSandbox(sandbox) {
  try {
    await sandbox.stop(30, true);
  } catch {
    // Ephemeral sandboxes may already be stopping; do not mask the repair result.
  }
}

function parseSandboxJson(output) {
  const line = String(output ?? "").trim().split("\n").findLast((candidate) => candidate.trim().startsWith("{"));
  if (!line) return { ok: false, raw: output };
  return JSON.parse(line);
}
