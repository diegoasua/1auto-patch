const scanButton = document.querySelector("#scanButton");
const resetButton = document.querySelector("#resetButton");
const probeDaytonaButton = document.querySelector("#probeDaytonaButton");
const probeBrowserButton = document.querySelector("#probeBrowserButton");
const results = document.querySelector("#results");
const riskyCount = document.querySelector("#riskyCount");
const statusEl = document.querySelector("#status");
const eventsEl = document.querySelector("#events");
const integrationsEl = document.querySelector("#integrations");

scanButton.addEventListener("click", scan);
resetButton.addEventListener("click", resetDemo);
probeDaytonaButton.addEventListener("click", probeDaytona);
probeBrowserButton.addEventListener("click", probeBrowser);
loadIntegrations();
scan();

async function scan() {
  try {
    status("Scanning");
    eventsEl.innerHTML = "";
    const items = await fetchJson("/api/scan", { method: "POST" });
    if (!Array.isArray(items)) throw new Error("Scan returned an unexpected response.");
    render(items);
    status("Ready");
  } catch (error) {
    status("Scan failed");
    results.innerHTML = "";
    riskyCount.textContent = "0";
    eventsEl.innerHTML = `<li>${escapeHtml(error.message)}</li>`;
  }
}

function render(items) {
  const risky = items.filter((item) => item.status === "risky");
  riskyCount.textContent = risky.length;
  results.innerHTML = items
    .map((item) => {
      const action = item.repairable
        ? `<button class="repair" data-id="${item.id}">Repair</button>`
        : `<button disabled title="${escapeHtml(item.repairNote)}">${item.adapter?.id === "agihouse-passwordless" ? "Passwordless" : "Needs adapter"}</button>`;
      return `
        <article class="row ${item.status}">
          <div>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.username)} · ${escapeHtml(item.website)}</p>
            <small>${escapeHtml(item.adapter?.label ?? "Unknown")} · ${escapeHtml(item.repairNote ?? "")}</small>
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
  try {
    const result = await fetchJson(`/api/repair/${id}`, { method: "POST" });
    eventsEl.innerHTML = (result.events ?? [])
      .map((event) => `<li><time>${new Date(event.at).toLocaleTimeString()}</time>${escapeHtml(event.message)}</li>`)
      .join("");
    if (!result.ok) {
      if (!eventsEl.innerHTML) eventsEl.innerHTML = `<li>${escapeHtml(result.error ?? "Repair failed")}</li>`;
      status("Repair failed");
      setBusy(false);
      return;
    }
    status("Password repaired");
    await scan();
  } catch (error) {
    eventsEl.innerHTML = `<li>${escapeHtml(error.message)}</li>`;
    status("Repair failed");
  } finally {
    setBusy(false);
  }
}

async function resetDemo() {
  try {
    status("Resetting");
    await fetchJson("/api/reset", { method: "POST" });
    eventsEl.innerHTML = "<li>Demo vault and target site reset to the weak starting credential.</li>";
    await scan();
  } catch (error) {
    status("Reset failed");
    eventsEl.innerHTML = `<li>${escapeHtml(error.message)}</li>`;
  }
}

async function loadIntegrations() {
  try {
    const data = await fetchJson("/api/integrations");
    integrationsEl.innerHTML = `
      <h2>Integrations</h2>
      <p><strong>Vault</strong><span>${escapeHtml(data.onePassword.mode)}</span></p>
      <p><strong>Daytona</strong><span>${data.daytona.configured ? "configured" : "not configured"}</span></p>
      <p><strong>Runtime</strong><span>${escapeHtml(data.repairRuntime)}</span></p>
    `;
    if (!data.onePassword.configured && data.vaultProvider === "1password") {
      eventsEl.innerHTML = `<li>1Password is not signed in for this server process: ${escapeHtml(data.onePassword.message)}</li>`;
    }
  } catch (error) {
    integrationsEl.innerHTML = `<h2>Integrations</h2><p><strong>Status</strong><span>unavailable</span></p>`;
    eventsEl.innerHTML = `<li>${escapeHtml(error.message)}</li>`;
  }
}

async function probeDaytona() {
  status("Probing Daytona");
  setBusy(true);
  eventsEl.innerHTML = "<li>Creating ephemeral Daytona sandbox.</li>";
  try {
    const result = await fetchJson("/api/daytona/probe", { method: "POST" });
    if (result.ok === false) {
      eventsEl.innerHTML += `<li>Daytona probe failed: ${escapeHtml(result.error ?? result.raw ?? "unknown error")}</li>`;
      status("Probe failed");
      setBusy(false);
      return;
    }
    eventsEl.innerHTML += `<li>Daytona sandbox responded from ${escapeHtml(result.cwd ?? "sandbox")} with ${escapeHtml(result.node ?? "Node")}.</li>`;
    status("Daytona ready");
    await loadIntegrations();
  } catch (error) {
    eventsEl.innerHTML += `<li>Daytona probe failed: ${escapeHtml(error.message)}</li>`;
    status("Probe failed");
  } finally {
    setBusy(false);
  }
}

async function probeBrowser() {
  status("Probing browser");
  setBusy(true);
  eventsEl.innerHTML = "<li>Starting Daytona computer-use browser probe.</li>";
  try {
    const result = await fetchJson("/api/daytona/browser-probe", { method: "POST" });
    if (result.ok === false) {
      eventsEl.innerHTML += `<li>Browser probe failed: ${escapeHtml(result.error ?? result.output ?? "unknown error")}</li>`;
      status("Probe failed");
      setBusy(false);
      return;
    }
    eventsEl.innerHTML += `<li>Daytona Chromium available: ${escapeHtml(result.output ?? "ok")}</li>`;
    status("Browser ready");
  } catch (error) {
    eventsEl.innerHTML += `<li>Browser probe failed: ${escapeHtml(error.message)}</li>`;
    status("Probe failed");
  } finally {
    setBusy(false);
  }
}

function status(text) {
  statusEl.textContent = text;
}

function setBusy(value) {
  scanButton.disabled = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}
