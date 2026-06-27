const base = process.env.BASE_URL ?? "http://localhost:3000";

await fetch(`${base}/api/reset`, { method: "POST" });

const scanBefore = await fetch(`${base}/api/scan`, { method: "POST" }).then((res) => res.json());
const target = scanBefore.find((item) => item.id === "agi-house-demo");
if (!target || target.status !== "risky") {
  throw new Error("Expected demo credential to start risky");
}

const repair = await fetch(`${base}/api/repair/agi-house-demo`, { method: "POST" }).then((res) => res.json());
if (!repair.ok) {
  throw new Error(`Repair failed: ${repair.error}`);
}

const scanAfter = await fetch(`${base}/api/scan`, { method: "POST" }).then((res) => res.json());
const repaired = scanAfter.find((item) => item.id === "agi-house-demo");
if (!repaired || repaired.status === "risky") {
  throw new Error("Expected demo credential to be repaired");
}

console.log("Smoke repair passed");
