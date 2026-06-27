import { CodeLanguage } from "@daytona/sdk";
import { createSandbox, stopSandbox } from "./daytona.js";

export async function probeDaytonaBrowser() {
  const sandbox = await createSandbox();
  try {
    await sandbox.computerUse.start();
    const response = await sandbox.process.executeCommand(
      "command -v chromium && chromium --version && node --version",
      undefined,
      undefined,
      30,
    );
    return {
      ok: response.exitCode === 0,
      runtime: "daytona-browser",
      output: response.result,
    };
  } finally {
    try {
      await sandbox.computerUse.stop();
    } catch {
      // Ignore cleanup errors so the probe result remains visible.
    }
    await stopSandbox(sandbox);
  }
}

export async function repairWithDaytonaBrowser(item, newPassword, adapter) {
  const target = buildTarget(item, adapter);
  const sandbox = await createSandbox({
    ITEM_TITLE: item.title,
    ITEM_USERNAME: item.username,
    ITEM_PASSWORD: item.password,
    NEW_PASSWORD: newPassword,
    TARGET_WEBSITE: target.website,
    TARGET_CHANGE_PASSWORD_URL: target.changePasswordUrl,
    REPAIR_ADAPTER: adapter.id,
  });

  try {
    await sandbox.computerUse.start();
    const response = await sandbox.process.codeRun(browserRepairProgram(), undefined, 120);
    const parsed = parseJsonLine(response.result);
    if (!parsed.ok) throw new Error(parsed.error ?? "Daytona browser repair failed");
    return parsed;
  } finally {
    try {
      await sandbox.computerUse.stop();
    } catch {
      // Ephemeral cleanup best effort.
    }
    await stopSandbox(sandbox);
  }
}

function buildTarget(item, adapter) {
  if (adapter.id === "demo-local") {
    if (!process.env.DAYTONA_PUBLIC_BASE_URL) {
      throw new Error("DAYTONA_PUBLIC_BASE_URL is required because Daytona cannot reach this app's localhost.");
    }
    const base = process.env.DAYTONA_PUBLIC_BASE_URL.replace(/\/$/, "");
    return {
      website: `${base}/target/login`,
      changePasswordUrl: `${base}/target/settings`,
    };
  }
  return {
    website: item.website,
    changePasswordUrl: item.changePasswordUrl || wellKnownChangePasswordUrl(item.website),
  };
}

function wellKnownChangePasswordUrl(value) {
  const url = new URL(value);
  return `${url.origin}/.well-known/change-password`;
}

function parseJsonLine(output) {
  const line = String(output ?? "")
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.trim().startsWith("{"));
  if (!line) return { ok: false, raw: output, error: "No JSON result from Daytona browser runner" };
  return JSON.parse(line);
}

function browserRepairProgram() {
  return String.raw`
    import { spawn } from "node:child_process";

    const events = [];
    const log = (message) => events.push({ at: new Date().toISOString(), message });

    class Cdp {
      constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id && this.pending.has(message.id)) {
            const { resolve, reject } = this.pending.get(message.id);
            this.pending.delete(message.id);
            message.error ? reject(new Error(message.error.message)) : resolve(message.result);
          }
        };
      }

      send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error("CDP timeout: " + method));
            }
          }, 20000);
        });
      }

      async eval(fn, ...args) {
        const expression = "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")";
        const result = await this.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
        }
        return result.result.value;
      }
    }

    async function main() {
      const adapter = process.env.REPAIR_ADAPTER;
      const browser = spawn("chromium", [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--user-data-dir=/tmp/credential-autopatch-browser",
        "about:blank",
      ], { stdio: "ignore" });

      try {
        const cdp = await connectCdp();
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");

        if (adapter === "agihouse-passwordless") {
          await inspectPasswordless(cdp);
          return { ok: false, classification: "passwordless", events, error: "AGI House uses magic link or Google sign-in; no password field exists to rotate." };
        }

        if (adapter === "demo-local") {
          await repairDemo(cdp);
        } else {
          await repairGeneric(cdp);
        }

        return { ok: true, runtime: "daytona-browser", adapter, events };
      } finally {
        browser.kill("SIGTERM");
      }
    }

    async function connectCdp() {
      for (let i = 0; i < 80; i++) {
        try {
          const targets = await fetch("http://127.0.0.1:9222/json/list").then((res) => res.json());
          const page = targets.find((target) => target.type === "page") || targets[0];
          if (page?.webSocketDebuggerUrl) {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
              ws.onopen = resolve;
              ws.onerror = () => reject(new Error("WebSocket failed"));
              setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
            });
            return new Cdp(ws);
          }
        } catch {}
        await sleep(250);
      }
      throw new Error("Chromium remote debugging did not start");
    }

    async function repairDemo(cdp) {
      log("Opening target login page in Daytona Chromium");
      await navigate(cdp, process.env.TARGET_WEBSITE);
      await cdp.eval(fillDemoLogin, process.env.ITEM_USERNAME, process.env.ITEM_PASSWORD);
      await waitForUrl(cdp, "/target/settings", 15000);

      log("Authenticated; opening password settings");
      await navigate(cdp, process.env.TARGET_CHANGE_PASSWORD_URL);
      await cdp.eval(fillDemoPasswordChange, process.env.ITEM_PASSWORD, process.env.NEW_PASSWORD);
      await waitForText(cdp, "Password changed", 15000);

      log("Website accepted password change; verifying new password");
      await navigate(cdp, process.env.TARGET_WEBSITE);
      await cdp.eval(fillDemoLogin, process.env.ITEM_USERNAME, process.env.NEW_PASSWORD);
      await waitForUrl(cdp, "/target/settings", 15000);
      log("Verified login with new password");
    }

    async function repairGeneric(cdp) {
      log("Opening login page in Daytona Chromium");
      await navigate(cdp, process.env.TARGET_WEBSITE);
      const login = await cdp.eval(loginWithHeuristics, process.env.ITEM_USERNAME, process.env.ITEM_PASSWORD);
      if (login.passwordless) throw new Error("No password field found. Site may be passwordless.");
      if (!login.submitted) throw new Error("Could not submit login form.");
      await sleep(3000);

      log("Looking for password-change page");
      const candidates = candidatePasswordUrls(process.env.TARGET_WEBSITE, process.env.TARGET_CHANGE_PASSWORD_URL);
      let found = false;
      for (const url of candidates) {
        await navigate(cdp, url).catch(() => {});
        await sleep(1500);
        const hasForm = await cdp.eval(hasPasswordChangeForm);
        if (hasForm) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error("Could not find a password-change form.");

      log("Filling password-change form");
      const changed = await cdp.eval(fillGenericPasswordChange, process.env.ITEM_PASSWORD, process.env.NEW_PASSWORD);
      if (!changed.submitted) throw new Error(changed.reason || "Could not submit password-change form.");
      await sleep(4000);

      const pageText = await cdp.eval(() => document.body.innerText.toLowerCase());
      if (pageText.includes("incorrect") || pageText.includes("invalid") || pageText.includes("failed")) {
        throw new Error("Password-change page reported a failure.");
      }
      log("Site did not report an immediate password-change failure");
    }

    function candidatePasswordUrls(loginUrl, explicitUrl) {
      const origin = new URL(loginUrl).origin;
      return [
        explicitUrl,
        origin + "/.well-known/change-password",
        origin + "/settings/security",
        origin + "/settings/password",
        origin + "/account/security",
        origin + "/account/password",
        origin + "/profile/security",
        origin + "/profile/password",
      ].filter(Boolean);
    }

    async function inspectPasswordless(cdp) {
      await navigate(cdp, "https://app.agihouse.org/");
      await cdp.eval(() => {
        [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "Sign in")?.click();
      });
      await sleep(1500);
      const state = await cdp.eval(() => ({
        emailInputs: document.querySelectorAll('input[type="email"]').length,
        passwordInputs: document.querySelectorAll('input[type="password"]').length,
        body: document.body.innerText,
      }));
      log("AGI House sign-in has " + state.emailInputs + " email input(s) and " + state.passwordInputs + " password input(s)");
    }

    async function navigate(cdp, url) {
      await cdp.send("Page.navigate", { url });
      await waitForReady(cdp);
    }

    async function waitForReady(cdp) {
      for (let i = 0; i < 80; i++) {
        const ready = await cdp.eval(() => document.readyState);
        if (ready === "complete" || ready === "interactive") {
          await sleep(500);
          return;
        }
        await sleep(250);
      }
    }

    async function waitForUrl(cdp, fragment, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const href = await cdp.eval(() => location.href);
        if (href.includes(fragment)) return;
        await sleep(250);
      }
      throw new Error("Timed out waiting for URL fragment: " + fragment);
    }

    async function waitForText(cdp, text, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await cdp.eval((needle) => document.body.innerText.includes(needle), text);
        if (found) return;
        await sleep(250);
      }
      throw new Error("Timed out waiting for text: " + text);
    }

    function fillDemoLogin(username, password) {
      document.querySelector('input[name="email"]').value = username;
      document.querySelector('input[name="password"]').value = password;
      document.querySelector('button[type="submit"]').click();
    }

    function fillDemoPasswordChange(currentPassword, newPassword) {
      document.querySelector('input[name="currentPassword"]').value = currentPassword;
      document.querySelector('input[name="newPassword"]').value = newPassword;
      document.querySelector('input[name="confirmPassword"]').value = newPassword;
      document.querySelector('button[type="submit"]').click();
    }

    function loginWithHeuristics(username, password) {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const inputs = [...document.querySelectorAll("input")].filter(visible);
      const passwordInput = inputs.find((input) => input.type === "password");
      if (!passwordInput) return { submitted: false, passwordless: true };
      const userInput =
        inputs.find((input) => ["email", "text"].includes(input.type) && /email|user|login/i.test([input.name, input.id, input.placeholder, input.autocomplete].join(" "))) ||
        inputs.find((input) => input.type === "email" || input.autocomplete === "username") ||
        inputs.find((input) => input !== passwordInput && ["text", "email"].includes(input.type));
      if (userInput) setInputValue(userInput, username);
      setInputValue(passwordInput, password);
      return submitNearby(passwordInput);
    }

    function hasPasswordChangeForm() {
      const passwordInputs = [...document.querySelectorAll('input[type="password"]')].filter((input) => input.offsetParent !== null);
      return passwordInputs.length >= 2;
    }

    function fillGenericPasswordChange(currentPassword, newPassword) {
      const passwordInputs = [...document.querySelectorAll('input[type="password"]')].filter((input) => input.offsetParent !== null);
      if (passwordInputs.length < 2) return { submitted: false, reason: "Need at least two visible password fields" };

      const current = passwordInputs.find((input) => /current|old|existing/i.test(fieldText(input))) || passwordInputs[0];
      const newOnes = passwordInputs.filter((input) => input !== current);
      const next = newOnes.find((input) => /new/i.test(fieldText(input))) || newOnes[0];
      const confirm = newOnes.find((input) => input !== next && /confirm|repeat|verify/i.test(fieldText(input))) || newOnes[1] || next;

      setInputValue(current, currentPassword);
      setInputValue(next, newPassword);
      setInputValue(confirm, newPassword);
      return submitNearby(next);
    }

    function fieldText(input) {
      const label = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
      return [input.name, input.id, input.placeholder, input.autocomplete, input.ariaLabel, label?.innerText, input.closest("label")?.innerText].filter(Boolean).join(" ");
    }

    function setInputValue(input, value) {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function submitNearby(input) {
      const form = input.closest("form");
      if (form) {
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return { submitted: true };
      }
      const buttons = [...document.querySelectorAll("button,input[type=submit]")].filter((button) => !button.disabled);
      const submit = buttons.find((button) => /save|change|update|submit|sign in|log in|continue/i.test(button.innerText || button.value || ""));
      if (submit) {
        submit.click();
        return { submitted: true };
      }
      return { submitted: false };
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    main()
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => console.log(JSON.stringify({ ok: false, error: error.message, events })));
  `;
}
