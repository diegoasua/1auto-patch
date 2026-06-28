import { resolveAdapter } from "./adapters.js";
import { ageDays, breachCount, scorePassword } from "./password.js";

const WEAK_SCORE_THRESHOLD = 70;

export async function scanItems(items) {
  const passwordUse = new Map();
  for (const item of items) {
    passwordUse.set(item.password, (passwordUse.get(item.password) ?? 0) + 1);
  }

  const results = [];
  for (const item of items) {
    const score = scorePassword(item.password);
    const breaches = await breachCount(item.password);
    const age = ageDays(item.updatedAt);
    const adapter = resolveAdapter(item);
    const reasons = [];
    if (score < WEAK_SCORE_THRESHOLD) reasons.push("weak");
    if (breaches > 0) reasons.push("known breach");
    if (passwordUse.get(item.password) > 1) reasons.push("reused");
    if (age > 365) reasons.push("old");

    results.push({
      id: item.id,
      title: item.title,
      website: item.website,
      username: item.username,
      score,
      breachCount: breaches,
      ageDays: age,
      adapter,
      repairable: adapter.repairable,
      repairNote: adapter.note,
      risk: reasons.length ? reasons.join(", ") : "ok",
      status: reasons.length ? "risky" : "ok",
    });
  }
  return results;
}
