const scopeSelect = document.getElementById("scopeSelect");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");
const openAnalyzerBtn = document.getElementById("openAnalyzerBtn");
const statsPanel = document.getElementById("statsPanel");
const logsBody = document.getElementById("logsBody");
const statusText = document.getElementById("statusText");

let currentLogs = [];
let currentSummary = { total: 0, networkCount: 0, consoleCount: 0, canvasCount: 0 };
let activeTabId = null;
let pollTimer = null;

function setStatus(message) {
  statusText.textContent = message || "";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function renderStats(summary) {
  const cards = [
    { label: "Total", value: summary.total || 0 },
    { label: "Network/Cookie", value: (summary.networkCount || 0) + (summary.cookieCount || 0) },
    { label: "Console", value: summary.consoleCount || 0 },
    { label: "Canvas", value: summary.canvasCount || 0 }
  ];

  statsPanel.innerHTML = "";
  for (const card of cards) {
    const el = document.createElement("div");
    el.className = "stat-card";
    el.innerHTML = `<div class="label">${card.label}</div><div class="value">${card.value}</div>`;
    statsPanel.appendChild(el);
  }
}

function renderLogs(logs) {
  logsBody.innerHTML = "";
  const rows = logs.slice(0, 150);
  for (const item of rows) {
    const tr = document.createElement("tr");

    const seq = document.createElement("td");
    seq.textContent = String(item.seq ?? "");

    const type = document.createElement("td");
    type.textContent = item.type || "";

    const iface = document.createElement("td");
    iface.textContent = item.interface || "";

    const member = document.createElement("td");
    member.textContent = item.member || "";

    tr.appendChild(seq);
    tr.appendChild(type);
    tr.appendChild(iface);
    tr.appendChild(member);
    logsBody.appendChild(tr);
  }
}

async function loadLogs() {
  const scope = scopeSelect.value === "tab" ? "tab" : "all";
  setStatus("Loading...");
  const res = await sendMessage({
    type: "ffa-get-logs",
    scope,
    tabId: activeTabId
  });
  if (!res?.ok) {
    throw new Error(res?.error || "Failed to load logs.");
  }
  currentLogs = Array.isArray(res.logs) ? res.logs : [];
  currentSummary = res.summary || { total: 0, networkCount: 0, consoleCount: 0, canvasCount: 0 };
  renderStats(currentSummary);
  renderLogs(currentLogs);
  const latestTime = currentLogs[0]?.ts ? fmtTime(currentLogs[0].ts) : "-";
  setStatus(`Loaded ${currentLogs.length} events. Latest: ${latestTime}`);
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function onExport() {
  const scope = scopeSelect.value;
  const payload = {
    generatedAt: new Date().toISOString(),
    scope,
    tabId: activeTabId,
    logs: currentLogs,
    summary: currentSummary
  };
  downloadJson(payload, `ffa_logs_${scope}_${Date.now()}.json`);
  setStatus("Export complete.");
}

async function onClear() {
  const scope = scopeSelect.value === "tab" ? "tab" : "all";
  setStatus("Clearing...");
  const res = await sendMessage({
    type: "ffa-clear-logs",
    scope,
    tabId: activeTabId
  });
  if (!res?.ok) {
    throw new Error(res?.error || "Failed to clear logs.");
  }
  await loadLogs();
  setStatus("Logs cleared.");
}

async function init() {
  const tab = await queryActiveTab();
  activeTabId = tab?.id ?? null;
  await loadLogs();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadLogs().catch(() => {});
  }, 2000);
}

refreshBtn.addEventListener("click", () => {
  loadLogs().catch((err) => setStatus(err.message));
});

clearBtn.addEventListener("click", () => {
  onClear().catch((err) => setStatus(err.message));
});

exportBtn.addEventListener("click", () => {
  onExport().catch((err) => setStatus(err.message));
});

scopeSelect.addEventListener("change", () => {
  loadLogs().catch((err) => setStatus(err.message));
});

openAnalyzerBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

init().catch((err) => setStatus(err.message));
