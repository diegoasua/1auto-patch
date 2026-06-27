import crypto from "node:crypto";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommonPackage from "@zxcvbn-ts/language-common";
import * as zxcvbnEnPackage from "@zxcvbn-ts/language-en";

const zxcvbn = new ZxcvbnFactory({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations,
});

const COMMON_PASSWORDS = new Set(
  zxcvbnCommonPackage.dictionary["passwords-common"].map((password) => password.toLowerCase()),
);

const SCORE_BY_ZXCVBN_BUCKET = [5, 25, 50, 75, 95];

export function scorePassword(password) {
  return assessPassword(password).score;
}

export function assessPassword(password, userInputs = []) {
  const result = zxcvbn.check(password, userInputs);
  const blocklisted = isBlocklistedByEstimator(password, result);
  let score = SCORE_BY_ZXCVBN_BUCKET[result.score] ?? 0;

  if (password.length < 8) score = Math.min(score, 20);
  else if (password.length < 12) score = Math.min(score, 45);
  else if (password.length < 15) score = Math.min(score, 65);
  if (blocklisted) score = Math.min(score, 10);

  return {
    score,
    zxcvbnScore: result.score,
    guessesLog10: result.guessesLog10,
    blocklisted,
    warning: result.feedback.warning ?? "",
    suggestions: result.feedback.suggestions ?? [],
    patterns: result.sequence.map((match) => ({
      pattern: match.pattern,
      token: match.token,
      dictionaryName: match.dictionaryName,
      regexName: match.regexName,
    })),
  };
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
    return isLocallyCommonPassword(password) ? 1000000 : 0;
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

function isLocallyCommonPassword(password) {
  const normalized = password.toLowerCase();
  return COMMON_PASSWORDS.has(normalized);
}

function isBlocklistedByEstimator(password, result) {
  const normalized = password.toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) return true;
  return result.sequence.some((match) => {
    return (
      match.pattern === "dictionary" &&
      match.dictionaryName === "passwords-common" &&
      match.token.length >= password.length - 2
    );
  });
}

export function ageDays(updatedAt) {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000);
}
