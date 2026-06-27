const scanButton = document.querySelector("#scanButton");
const resetButton = document.querySelector("#resetButton");
const probeDaytonaButton = document.querySelector("#probeDaytonaButton");
const results = document.querySelector("#results");
const riskyCount = document.querySelector("#riskyCount");
const statusEl = document.querySelector("#status");
const eventsEl = document.querySelector("#events");
const integrationsEl = document.querySelector("#integrations");

scanButton.addEventListener("click", scan);
resetButton.addEventListener("click", resetDemo);
probeDaytonaButton.addEventListener("click", probeDaytona);
loadIntegrations();
scan();

async function scan() {
  status("Scanning");
  eventsEl.innerHTML = "";
  const res = await fetch("/api/scan", { method: "POST" });
  const items = await res.json();
  render(items);
  status("Ready");
}

function render(items) {
  const risky = items.filter((item) => item.status === "risky");
  riskyCount.textContent = risky.length;
  results.innerHTML = items
    .map((item) => {
      const action = item.repairable
        ? `<button class="repair" data-id="${item.id}">Repair</button>`
        : `<button disabled title="No adapter in demo">Needs adapter</button>`;
      return `
        <article class="row ${item.status}">
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.username)} · ${escapeHtml(item.website)}</p>
          </div>
          <div class="score">
            <strong>${item.score}</strong>
            <span>${escapeHtml(item.risk)}</span>
          </div>
          ${item.status === "risky" ? action : "<span class='ok'>OK</span>"}
        </article>
      `;
    })
    .join("");

  for (const button of document.querySelectorAll(".repair")) {
    button.addEventListener("click", () => repair(button.dataset.id));
  }
}

async function repair(id) {
  status("Repairing");
  setBusy(true);
  eventsEl.innerHTML = "<li>Approval received. Starting contained agent run.</li>";
  const res = await fetch(`/api/repair/${id}`, { method: "POST" });
  const result = await res.json();
  eventsEl.innerHTML = result.events
    .map((event) => `<li><time>${new Date(event.at).toLocaleTimeString()}</time>${escapeHtml(event.message)}</li>`)
    .join("");
  if (!result.ok) {
    status("Repair failed");
    setBusy(false);
    return;
  }
  status("Password repaired");
  await scan();
  setBusy(false);
}

async function resetDemo() {
  status("Resetting");
  await fetch("/api/reset", { method: "POST" });
  eventsEl.innerHTML = "<li>Demo vault and target site reset to the weak starting credential.</li>";
  await scan();
}

async function loadIntegrations() {
  const res = await fetch("/api/integrations");
  const data = await res.json();
  integrationsEl.innerHTML = `
    <h2>Integrations</h2>
    <p><strong>Vault</strong><span>${escapeHtml(data.onePassword.mode)}</span></p>
    <p><strong>Daytona</strong><span>${data.daytona.configured ? "configured" : "not configured"}</span></p>
    <p><strong>Runtime</strong><span>${escapeHtml(data.repairRuntime)}</span></p>
  `;
}

async function probeDaytona() {
  status("Probing Daytona");
  setBusy(true);
  eventsEl.innerHTML = "<li>Creating ephemeral Daytona sandbox.</li>";
  const res = await fetch("/api/daytona/probe", { method: "POST" });
  const result = await res.json();
  if (!res.ok || result.ok === false) {
    eventsEl.innerHTML += `<li>Daytona probe failed: ${escapeHtml(result.error ?? result.raw ?? "unknown error")}</li>`;
    status("Probe failed");
    setBusy(false);
    return;
  }
  eventsEl.innerHTML += `<li>Daytona sandbox responded from ${escapeHtml(result.cwd ?? "sandbox")} with ${escapeHtml(result.node ?? "Node")}.</li>`;
  status("Daytona ready");
  await loadIntegrations();
  setBusy(false);
}

function status(text) {
  statusEl.textContent = text;
}

function setBusy(value) {
  scanButton.disabled = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}
