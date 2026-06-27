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
    if (!parsed.ok) throw new DaytonaRepairError(parsed);
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

class DaytonaRepairError extends Error {
  constructor(result) {
    super(result.error ?? "Daytona browser repair failed");
    this.name = "DaytonaRepairError";
    this.events = result.events ?? [];
    this.result = result;
    this.raw = result.raw;
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
  try {
    return JSON.parse(line);
  } catch (error) {
    return { ok: false, raw: output, error: "Could not parse Daytona browser runner JSON: " + error.message };
  }
}

function browserRepairProgram() {
  return String.raw`
    import { spawn } from "node:child_process";

    const events = [];
    let currentPhase = "boot";
    const log = (message) => {
      currentPhase = message;
      events.push({ at: new Date().toISOString(), message });
    };

    class Cdp {
      constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.pageExceptions = [];
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.method === "Runtime.exceptionThrown") {
            this.pageExceptions.push(formatExceptionDetails(message.params.exceptionDetails));
            this.pageExceptions = this.pageExceptions.slice(-5);
          }
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
              reject(new Error("CDP timeout during " + currentPhase + ": " + method));
            }
          }, 20000);
        });
      }

      async eval(fn, ...args) {
        const expression =
          "(() => {\n" +
          pageHelperSource() +
          "\nreturn (" + fn.toString() + ")(..." + JSON.stringify(args) + ");\n" +
          "})()";
        const result = await this.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error("Browser eval failed in " + functionLabel(fn) + " during " + currentPhase + ": " + formatExceptionDetails(result.exceptionDetails));
        }
        return result.result.value;
      }

      async evalRaw(expression) {
        const result = await this.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(formatExceptionDetails(result.exceptionDetails));
        }
        return result.result.value;
      }
    }

    function functionLabel(fn) {
      return fn.name || "anonymous browser function";
    }

    function formatExceptionDetails(details = {}) {
      const exception = details.exception ?? {};
      const description = exception.description || exception.value || details.text || "Browser evaluation failed";
      const frame = details.stackTrace?.callFrames?.[0];
      const location = frame
        ? " at " + (frame.functionName || "anonymous") + ":" + (frame.lineNumber + 1) + ":" + (frame.columnNumber + 1)
        : details.lineNumber != null
          ? " at eval:" + (details.lineNumber + 1) + ":" + ((details.columnNumber ?? 0) + 1)
          : "";
      return String(description).split("\n").slice(0, 4).join(" | ") + location;
    }

    function pageHelperSource() {
      return [
        sleep,
        firstMatch,
        findUsernameInput,
        fieldText,
        setInputValue,
        submitNearby,
        findSubmitControl,
        isPasswordlessButton,
        buttonText,
      ].map((fn) => fn.toString()).join("\n");
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
        await cdp.send("Network.enable");
        log("Connected to Daytona Chromium");

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
      await logPageState(cdp, "Loaded demo login page");
      await cdp.eval(fillDemoLogin, process.env.ITEM_USERNAME, process.env.ITEM_PASSWORD);
      await waitForUrl(cdp, "/target/settings", 15000);

      log("Authenticated; opening password settings");
      await navigate(cdp, process.env.TARGET_CHANGE_PASSWORD_URL);
      await logPageState(cdp, "Loaded demo password settings");
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
      await logPageState(cdp, "Loaded login page");
      const login = await cdp.eval(loginWithHeuristics, process.env.ITEM_USERNAME, process.env.ITEM_PASSWORD);
      log("Submitted login form");
      if (login.passwordless) throw new Error("No password field found. Site may be passwordless.");
      if (!login.submitted) throw new Error("Could not submit login form.");
      await sleep(3000);
      await logPageState(cdp, "State after login submit");
      const loginState = await cdp.eval(classifyAuthState, process.env.TARGET_WEBSITE);
      if (loginState.failed) throw new Error("Login failed before password repair: " + loginState.reason);

      log("Looking for password-change page");
      const found = await discoverPasswordChangePage(cdp, process.env.TARGET_WEBSITE, process.env.TARGET_CHANGE_PASSWORD_URL);
      if (!found) throw new Error("Could not discover a password-change form.");

      log("Filling password-change form");
      await logPageState(cdp, "Ready to submit password-change form");
      const changed = await cdp.eval(fillGenericPasswordChange, process.env.ITEM_PASSWORD, process.env.NEW_PASSWORD);
      if (!changed.submitted) throw new Error(changed.reason || "Could not submit password-change form.");
      await sleep(4000);
      await logPageState(cdp, "State after password-change submit");

      const changeState = await cdp.eval(classifyPasswordChangeState);
      if (changeState.failed) throw new Error("Password-change page reported a failure: " + changeState.reason);
      if (changeState.succeeded) {
        log("Website reported password-change success");
      } else {
        log("Password-change success was ambiguous; verifying new password before vault update");
      }

      log("Verifying new password in a fresh browser session");
      await clearBrowserState(cdp);
      await navigate(cdp, process.env.TARGET_WEBSITE);
      await logPageState(cdp, "Loaded fresh login page for verification");
      const verify = await cdp.eval(loginWithHeuristics, process.env.ITEM_USERNAME, process.env.NEW_PASSWORD);
      log("Submitted verification login form");
      if (verify.passwordless) throw new Error("Verification login found no password field.");
      if (!verify.submitted) throw new Error("Could not submit verification login.");
      await sleep(4000);
      await logPageState(cdp, "State after verification submit");
      const verifyState = await cdp.eval(classifyAuthState, process.env.TARGET_WEBSITE);
      if (verifyState.failed) throw new Error("New password verification failed: " + verifyState.reason);
      if (!verifyState.succeeded) throw new Error("New password verification was inconclusive; refusing to update the vault.");
      log("Verified login with new password");
    }

    async function discoverPasswordChangePage(cdp, loginUrl, explicitUrl) {
      const visited = new Set();
      const queue = candidatePasswordUrls(loginUrl, explicitUrl);
      const initialLinks = await cdp.eval(extractPasswordCandidateLinks, loginUrl);
      for (const link of initialLinks) queue.push(link.url);
      log("Discovered " + initialLinks.length + " candidate link(s) after login");

      for (let attempts = 0; queue.length > 0 && attempts < 18; attempts++) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);
        log("Checking candidate password page: " + url);
        await navigate(cdp, url).catch((error) => log("Navigation failed: " + error.message));
        await sleep(1500);
        await logPageState(cdp, "Candidate page loaded");

        const hasForm = await cdp.eval(hasPasswordChangeForm);
        if (hasForm) {
          log("Found password-change form at " + (await cdp.eval(() => location.href)));
          return true;
        }

        const links = await cdp.eval(extractPasswordCandidateLinks, loginUrl);
        for (const link of links) {
          if (!visited.has(link.url) && !queue.includes(link.url)) queue.push(link.url);
        }
      }
      return false;
    }

    function candidatePasswordUrls(loginUrl, explicitUrl) {
      const origin = new URL(loginUrl).origin;
      const explicit = explicitUrl && explicitUrl !== loginUrl ? [explicitUrl] : [];
      return [...new Set([
        ...explicit,
        ...knownProviderPasswordUrls(loginUrl),
        origin + "/.well-known/change-password",
        origin + "/settings/security",
        origin + "/settings/password",
        origin + "/account/security",
        origin + "/account/password",
        origin + "/profile/security",
        origin + "/profile/password",
        origin + "/user/settings",
        origin + "/preferences",
        origin + "/my/preferences/account",
        origin + "/auth/edit",
      ].filter(Boolean))];
    }

    function knownProviderPasswordUrls(loginUrl) {
      const url = new URL(loginUrl);
      const host = url.hostname.replace(/^www\./, "");
      if (host === "auth.wikimedia.org" || host.endsWith(".wikipedia.org") || host.endsWith(".wikimedia.org")) {
        return [
          "https://auth.wikimedia.org/enwiki/wiki/Special:ChangePassword",
          "https://auth.wikimedia.org/enwiki/wiki/Special:ChangeCredentials/MediaWiki%5CAuth%5CPasswordAuthenticationRequest",
        ];
      }
      if (host === "mastodon.social" || locationLooksLikeMastodon(loginUrl)) {
        return [new URL("/auth/edit", loginUrl).href];
      }
      if (host.endsWith("discourse.org") || host.includes("forum.") || host.includes("discuss.")) {
        return [new URL("/my/preferences/account", loginUrl).href];
      }
      if (host === "dev.to") {
        return [new URL("/settings/account", loginUrl).href, new URL("/settings", loginUrl).href];
      }
      return [];
    }

    function locationLooksLikeMastodon(loginUrl) {
      const path = new URL(loginUrl).pathname;
      return path.startsWith("/auth/");
    }

    function extractPasswordCandidateLinks(loginUrl) {
      const login = new URL(loginUrl);
      const sameSite = (candidate) => {
        if (candidate.origin === login.origin) return true;
        const loginParts = login.hostname.split(".").slice(-2).join(".");
        const candidateParts = candidate.hostname.split(".").slice(-2).join(".");
        return loginParts === candidateParts;
      };
      const scored = [...document.querySelectorAll("a[href]")]
        .map((link) => {
          try {
            const url = new URL(link.href, location.href);
            const haystack = [link.innerText, link.textContent, link.title, link.ariaLabel, link.href].filter(Boolean).join(" ").toLowerCase();
            if (!["http:", "https:"].includes(url.protocol)) return null;
            if (!sameSite(url)) return null;
            if (/logout|sign.?out|delete|remove|privacy|terms|billing|invoice|subscribe/.test(haystack)) return null;
            let score = 0;
            if (/change.{0,20}password|password.{0,20}change|password/.test(haystack)) score += 100;
            if (/security|credential|account|settings|profile|preferences/.test(haystack)) score += 35;
            if (/settings|account|profile|preferences|security|password|credential/.test(url.pathname.toLowerCase())) score += 25;
            if (/help|support|docs|blog|event|post|search|notification|message/.test(haystack)) score -= 40;
            return score > 0 ? { url: url.href, score } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      return [...new Map(scored.map((item) => [item.url, item])).values()].slice(0, 12);
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
      await sleep(700);
      await waitForReady(cdp);
    }

    async function logPageState(cdp, label) {
      const state = await pageState(cdp);
      if (state.error) {
        log(label + ": page state unavailable: " + state.error);
        return;
      }
      const fields = [
        state.passwordInputs + " password field(s)",
        state.inputs + " input(s)",
        state.buttons + " button(s)",
      ].join(", ");
      log(label + ": " + (state.title || "untitled") + " @ " + state.href + " [" + fields + "]");
      if (state.recentException) log("Recent page exception: " + state.recentException);
    }

    async function pageState(cdp) {
      try {
        const state = await cdp.evalRaw(
          "(() => {" +
            "const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);" +
            "return {" +
              "href: location.href," +
              "title: document.title," +
              "readyState: document.readyState," +
              "inputs: [...document.querySelectorAll('input')].filter(visible).length," +
              "passwordInputs: [...document.querySelectorAll('input[type=\"password\"]')].filter(visible).length," +
              "buttons: [...document.querySelectorAll('button,input[type=submit]')].filter(visible).length" +
            "};" +
          "})()",
        );
        return { ...state, recentException: cdp.pageExceptions.at(-1) };
      } catch (error) {
        return { error: error.message };
      }
    }

    async function clearBrowserState(cdp) {
      await cdp.send("Network.clearBrowserCookies").catch(() => {});
      await cdp.send("Network.clearBrowserCache").catch(() => {});
      const origin = new URL(process.env.TARGET_WEBSITE).origin;
      await cdp.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "appcache,cookies,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage",
      }).catch(() => {});
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

    async function loginWithHeuristics(username, password) {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const inputs = [...document.querySelectorAll("input")].filter(visible);
      let passwordInput = inputs.find((input) => input.type === "password");
      if (!passwordInput) {
        const userOnly = findUsernameInput(inputs);
        if (userOnly) {
          const submit = findSubmitControl(userOnly, { login: true, allowContinue: true });
          if (submit && !isPasswordlessButton(submit)) {
            setInputValue(userOnly, username);
            submit.click();
            await sleep(2000);
            passwordInput = [...document.querySelectorAll("input")].filter(visible).find((input) => input.type === "password");
          }
        }
      }
      if (!passwordInput) return { submitted: false, passwordless: true };
      const refreshedInputs = [...document.querySelectorAll("input")].filter(visible);
      const userInput =
        findUsernameInput(refreshedInputs) ||
        refreshedInputs.find((input) => input !== passwordInput && ["text", "email"].includes(input.type));
      if (userInput) setInputValue(userInput, username);
      setInputValue(passwordInput, password);
      return submitNearby(passwordInput, { login: true });
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
      return submitNearby(next, { passwordChange: true });
    }

    function classifyAuthState(targetWebsite) {
      const text = document.body.innerText.toLowerCase();
      const href = location.href.toLowerCase();
      const visiblePasswordInputs = [...document.querySelectorAll('input[type="password"]')].filter((input) => input.offsetParent !== null).length;
      const failure = firstMatch(text, [
        "invalid e-mail address or password",
        "invalid email address or password",
        "incorrect password",
        "invalid password",
        "wrong password",
        "invalid username",
        "invalid login",
        "login failed",
        "sign in failed",
        "authentication failed",
        "couldn't log you in",
      ]);
      if (failure) return { failed: true, succeeded: false, reason: failure, href, visiblePasswordInputs };
      const success = firstMatch(text, ["log out", "logout", "sign out", "account settings", "profile", "preferences", "compose", "home"]);
      const loginishUrl = /login|signin|sign_in|session|auth/.test(href);
      const noPasswordForm = visiblePasswordInputs === 0;
      const changedAway = !loginishUrl && href !== String(targetWebsite ?? "").toLowerCase();
      return {
        failed: false,
        succeeded: Boolean(success || changedAway || (noPasswordForm && !loginishUrl)),
        reason: success || (changedAway ? "navigated away from login" : noPasswordForm ? "password form disappeared" : ""),
        href,
        visiblePasswordInputs,
      };
    }

    function classifyPasswordChangeState() {
      const text = document.body.innerText.toLowerCase();
      const failure = firstMatch(text, [
        "incorrect current password",
        "current password is incorrect",
        "old password is incorrect",
        "invalid password",
        "passwords do not match",
        "password doesn't meet",
        "password does not meet",
        "failed",
        "error",
      ]);
      if (failure) return { failed: true, succeeded: false, reason: failure };
      const success = firstMatch(text, [
        "password changed",
        "password has been changed",
        "password updated",
        "password has been updated",
        "changes saved",
        "saved successfully",
        "successfully changed",
        "successfully updated",
      ]);
      return { failed: false, succeeded: Boolean(success), reason: success || "" };
    }

    function firstMatch(text, phrases) {
      return phrases.find((phrase) => text.includes(phrase)) || "";
    }

    function findUsernameInput(inputs) {
      return (
        inputs.find((input) => ["email", "text"].includes(input.type) && /email|user|login|account/i.test(fieldText(input))) ||
        inputs.find((input) => input.type === "email" || input.autocomplete === "username")
      );
    }

    function fieldText(input) {
      const label = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
      return [input.name, input.id, input.placeholder, input.autocomplete, input.ariaLabel, label?.innerText, input.closest("label")?.innerText].filter(Boolean).join(" ");
    }

    function setInputValue(input, value) {
      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
      descriptor?.set ? descriptor.set.call(input, value) : (input.value = value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function submitNearby(input, intent = {}) {
      const form = input.closest("form");
      if (form) {
        const formSubmit = findSubmitControl(input, intent, form);
        if (formSubmit) formSubmit.click();
        else form.requestSubmit ? form.requestSubmit() : form.submit();
        return { submitted: true };
      }
      const submit = findSubmitControl(input, intent);
      if (submit) {
        submit.click();
        return { submitted: true };
      }
      return { submitted: false };
    }

    function findSubmitControl(input, intent = {}, scope = document) {
      const buttons = [...document.querySelectorAll("button,input[type=submit]")].filter((button) => !button.disabled);
      const scoped = scope === document ? buttons : buttons.filter((button) => scope.contains(button));
      const candidates = scoped.length ? scoped : buttons;
      const labels = intent.passwordChange
        ? [/change password/i, /update password/i, /^save$/i, /save changes/i, /update/i, /change/i, /submit/i]
        : intent.login
          ? [/sign in/i, /log in/i, /^login$/i, /continue/i, /next/i, /submit/i]
          : [/continue/i, /next/i, /submit/i];
      return candidates.find((button) => {
        const text = buttonText(button);
        return !isPasswordlessButton(button) && labels.some((pattern) => pattern.test(text));
      });
    }

    function isPasswordlessButton(button) {
      return /magic link|one-time|one time|otp|verification code|passkey|webauthn|google|github|sso|single sign/i.test(buttonText(button));
    }

    function buttonText(button) {
      return [button.innerText, button.value, button.name, button.id, button.getAttribute("aria-label")].filter(Boolean).join(" ").trim();
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    main()
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        const pageException = error?.pageExceptions?.at?.(-1);
        console.log(JSON.stringify({
          ok: false,
          error: error.message || String(error),
          phase: currentPhase,
          pageException,
          events,
        }));
      });
  `;
}
