import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairPassword } from "./agent.js";
import { daytonaStatus, probeDaytona } from "./daytona.js";
import { onePasswordStatus } from "./onepassword.js";
import { scanItems } from "./scanner.js";
import { getItem, listItems, resetVault } from "./vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT ?? 3000);

const targetAccount = {
  email: "diego@example.com",
  password: "summer2024",
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/items", async (_req, res, next) => {
  try {
    const items = await listItems();
    res.json(items.map(({ password, ...item }) => ({ ...item, passwordLength: password.length })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scan", async (_req, res, next) => {
  try {
    res.json(await scanItems(await listItems()));
  } catch (error) {
    next(error);
  }
});

app.get("/api/integrations", async (_req, res, next) => {
  try {
    res.json({
      vaultProvider: process.env.VAULT_PROVIDER ?? "local",
      repairRuntime: process.env.REPAIR_RUNTIME ?? "local",
      onePassword: await onePasswordStatus(),
      daytona: daytonaStatus(),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/daytona/probe", async (_req, res, next) => {
  try {
    res.json(await probeDaytona());
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.post("/api/repair/:id", async (req, res, next) => {
  try {
    const item = normalizeDemoTarget(await getItem(req.params.id));
    if (!isDemoTarget(item.website)) {
      res.status(422).json({ ok: false, error: "No demo adapter for this website yet." });
      return;
    }
    res.json(await repairPassword(item));
  } catch (error) {
    next(error);
  }
});

app.post("/api/reset", async (_req, res, next) => {
  try {
    await resetVault();
    targetAccount.password = "summer2024";
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/target/login", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <head>
        <title>AGI House Demo Login</title>
        <link rel="stylesheet" href="/target.css">
      </head>
      <body>
        <main class="target">
          <h1>AGI House Demo</h1>
          <form method="post" action="/target/login">
            <label>Email <input name="email" type="email" autocomplete="username" required></label>
            <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body>
    </html>
  `);
});

app.post("/target/login", (req, res) => {
  if (req.body.email === targetAccount.email && req.body.password === targetAccount.password) {
    res.redirect("/target/settings");
    return;
  }
  res.status(401).type("html").send("Invalid credentials");
});

app.get("/target/settings", (_req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <head>
        <title>Password Settings</title>
        <link rel="stylesheet" href="/target.css">
      </head>
      <body>
        <main class="target">
          <h1>Security Settings</h1>
          <form method="post" action="/target/settings">
            <label>Current password <input name="currentPassword" type="password" autocomplete="current-password" required></label>
            <label>New password <input name="newPassword" type="password" autocomplete="new-password" required></label>
            <label>Confirm password <input name="confirmPassword" type="password" autocomplete="new-password" required></label>
            <button type="submit">Change password</button>
          </form>
        </main>
      </body>
    </html>
  `);
});

app.post("/target/settings", (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (currentPassword !== targetAccount.password) {
    res.status(401).type("html").send("Current password is wrong");
    return;
  }
  if (newPassword !== confirmPassword || newPassword.length < 16) {
    res.status(422).type("html").send("New password rejected");
    return;
  }
  targetAccount.password = newPassword;
  res.type("html").send(`
    <!doctype html>
    <html>
      <head><link rel="stylesheet" href="/target.css"></head>
      <body>
        <main class="target">
          <h1 data-testid="success">Password changed</h1>
          <p>Your account now has a stronger password.</p>
        </main>
      </body>
    </html>
  `);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: error.message });
});

function isDemoTarget(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.startsWith("/target");
  } catch {
    return false;
  }
}

function normalizeDemoTarget(item) {
  if (!isDemoTarget(item.website)) return item;
  const rewrite = (value) => {
    const url = new URL(value);
    url.protocol = "http:";
    url.hostname = "localhost";
    url.port = String(port);
    return url.toString();
  };
  return {
    ...item,
    website: rewrite(item.website),
    changePasswordUrl: item.changePasswordUrl ? rewrite(item.changePasswordUrl) : `http://localhost:${port}/target/settings`,
  };
}

try {
  const demoItem = await getItem("agi-house-demo");
  targetAccount.password = demoItem.password;
} catch {
  targetAccount.password = "summer2024";
}

app.listen(port, () => {
  console.log(`Credential Autopatch running at http://localhost:${port}`);
});
