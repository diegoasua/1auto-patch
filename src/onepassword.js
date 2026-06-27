import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function onePasswordStatus() {
  const available = await hasOpCli();
  if (!available) {
    return {
      configured: false,
      available: false,
      mode: "1Password CLI unavailable",
      message: "1Password CLI `op` is not installed or not on PATH.",
    };
  }

  try {
    const { stdout } = await op(["whoami", "--format", "json"]);
    const account = JSON.parse(stdout);
    return {
      configured: true,
      available: true,
      mode: "1Password CLI",
      account: account.account_uuid ?? account.url ?? "signed in",
      vault: process.env.OP_VAULT ?? "all accessible vaults",
      message: "Signed in to 1Password CLI.",
    };
  } catch (error) {
    return {
      configured: false,
      available: true,
      mode: "1Password CLI signed out",
      vault: process.env.OP_VAULT ?? null,
      message: cleanError(error),
    };
  }
}

export async function listOnePasswordItems() {
  const args = ["item", "list", "--categories", "login", "--format", "json"];
  if (process.env.OP_VAULT) args.push("--vault", process.env.OP_VAULT);
  const { stdout } = await op(args);
  const summaries = JSON.parse(stdout).slice(0, Number(process.env.OP_ITEM_LIMIT ?? 25));
  const items = [];

  for (const summary of summaries) {
    const item = await getOnePasswordItem(summary.id);
    if (item?.password) items.push(item);
  }

  return items;
}

export async function getOnePasswordItem(id) {
  const { stdout } = await op(["item", "get", id, "--format", "json", "--reveal"]);
  const raw = JSON.parse(stdout);
  const username = fieldValue(raw, ["username", "email"]);
  const password = passwordField(raw)?.value;
  const website = raw.urls?.[0]?.href ?? raw.url ?? "";
  const explicitChangePasswordUrl =
    fieldValue(raw, ["changePasswordUrl", "change password url", "password change url", "security url"]) ||
    raw.urls?.find((url) => /change|password|security/i.test([url.label, url.href].filter(Boolean).join(" ")))?.href;
  const changePasswordUrl = website.includes("/target/login")
    ? website.replace("/target/login", "/target/settings")
    : explicitChangePasswordUrl ?? raw.changePasswordUrl ?? website;
  return {
    id: raw.id,
    title: raw.title,
    website,
    changePasswordUrl,
    username,
    password,
    updatedAt: raw.updated_at ?? raw.updatedAt ?? new Date().toISOString(),
    tags: raw.tags ?? [],
    provider: "1password",
  };
}

export async function updateOnePasswordPassword(id, password) {
  const field = process.env.OP_PASSWORD_FIELD ?? "password";
  const attempts = [
    ["item", "edit", id, `${field}[password]=${password}`],
    ["item", "edit", id, `${field}=${password}`],
  ];

  let lastError;
  for (const args of attempts) {
    try {
      await op(args);
      return getOnePasswordItem(id);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function hasOpCli() {
  try {
    await execFileAsync("op", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function op(args) {
  const env = { ...process.env };
  const options = { env, maxBuffer: 1024 * 1024 * 10 };
  return execFileAsync("op", args, options);
}

function fieldValue(item, names) {
  for (const name of names) {
    const found = item.fields?.find((field) => {
      return [field.id, field.label, field.purpose].filter(Boolean).some((value) => {
        return String(value).toLowerCase() === name.toLowerCase();
      });
    });
    if (found?.value) return found.value;
  }
  return "";
}

function passwordField(item) {
  return item.fields?.find((field) => {
    return field.type === "CONCEALED" && [field.id, field.label, field.purpose].filter(Boolean).some((value) => {
      return String(value).toLowerCase().includes("password");
    });
  });
}

function cleanError(error) {
  return String(error.stderr || error.message || error).trim();
}
