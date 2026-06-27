import crypto from "node:crypto";

const COMMON = new Set([
  "password",
  "password123",
  "qwerty",
  "letmein",
  "summer2024",
  "admin",
  "welcome",
]);

export function scorePassword(password) {
  const length = password.length;
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  const commonPenalty = COMMON.has(password.toLowerCase()) ? 45 : 0;
  const repeatPenalty = /(.)\1{2,}/.test(password) ? 15 : 0;
  const sequencePenalty = /(1234|abcd|qwerty|password)/i.test(password) ? 25 : 0;
  const raw = length * 4 + classes * 12 - commonPenalty - repeatPenalty - sequencePenalty;
  return Math.max(0, Math.min(100, raw));
}

export function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  let password = "";
  while (password.length < 24) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < alphabet.length * 3) password += alphabet[byte % alphabet.length];
  }
  return password;
}

export async function breachCount(password) {
  if (process.env.HIBP_LIVE_CHECK !== "true") {
    return COMMON.has(password.toLowerCase()) ? 1000000 : 0;
  }

  const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "User-Agent": "credential-autopatch-hackathon-demo" },
  });
  if (!res.ok) throw new Error(`Breach lookup failed: HTTP ${res.status}`);
  const body = await res.text();
  const match = body
    .split("\n")
    .map((line) => line.trim().split(":"))
    .find(([candidate]) => candidate === suffix);
  return match ? Number(match[1]) : 0;
}

export function ageDays(updatedAt) {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
}
