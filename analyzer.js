const fileInput = document.getElementById("fileInput");
const loadLiveBtn = document.getElementById("loadLiveBtn");
const exportBtn = document.getElementById("exportBtn");
const styleBtn = document.getElementById("styleBtn");
const interfaceFilter = document.getElementById("interfaceFilter");
const memberFilter = document.getElementById("memberFilter");
const textFilter = document.getElementById("textFilter");
const summaryPanel = document.getElementById("summaryPanel");
const resultInfo = document.getElementById("resultInfo");
const statsBody = document.getElementById("statsBody");
const networkBody = document.getElementById("networkBody");
const consoleBody = document.getElementById("consoleBody");
const canvasBody = document.getElementById("canvasBody");
const stylePanel = document.getElementById("stylePanel");
const fontFamilyInput = document.getElementById("fontFamilyInput");
const fontSizeInput = document.getElementById("fontSizeInput");
const accentInput = document.getElementById("accentInput");
const bgInput = document.getElementById("bgInput");
const cardInput = document.getElementById("cardInput");
const saveStyleBtn = document.getElementById("saveStyleBtn");
const resetStyleBtn = document.getElementById("resetStyleBtn");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const STYLE_KEY = "ffa_style_settings_v1";
const DEFAULT_STYLE = {
  fontFamily: "Segoe UI",
  fontSize: 13,
  accent: "#0b63f3",
  bg: "#f5f7fb",
  card: "#ffffff"
};

const CANVAS_INTERFACES = {
  HTMLCanvasElement: new Set(["toDataURL", "getContext", "toBlob"]),
  CanvasRenderingContext2D: new Set([
    "fillText",
    "strokeText",
    "measureText",
    "getImageData",
    "putImageData",
    "fillRect",
    "strokeRect",
    "arc",
    "ellipse",
    "bezierCurveTo",
    "quadraticCurveTo",
    "createRadialGradient",
    "createLinearGradient",
    "drawImage",
    "fill",
    "stroke",
    "isPointInPath",
    "createPattern"
  ]),
  TextMetrics: new Set([
    "width",
    "actualBoundingBoxAscent",
    "actualBoundingBoxDescent",
    "actualBoundingBoxLeft",
    "actualBoundingBoxRight",
    "fontBoundingBoxAscent",
    "fontBoundingBoxDescent"
  ]),
  OffscreenCanvas: new Set(["getContext", "convertToBlob"]),
  OffscreenCanvasRenderingContext2D: new Set(["fillText", "strokeText", "getImageData"])
};

let logs = [];
let activeTab = "stats";

function applyStyleSettings(settings) {
  const root = document.documentElement;
  root.style.setProperty("--font-family", settings.fontFamily || DEFAULT_STYLE.fontFamily);
  root.style.setProperty("--font-size", `${settings.fontSize || DEFAULT_STYLE.fontSize}px`);
  root.style.setProperty("--accent", settings.accent || DEFAULT_STYLE.accent);
  root.style.setProperty("--bg", settings.bg || DEFAULT_STYLE.bg);
  root.style.setProperty("--card", settings.card || DEFAULT_STYLE.card);
}

function readStyleSettings() {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (!raw) return { ...DEFAULT_STYLE };
    const parsed = JSON.parse(raw);
    return {
      fontFamily: parsed.fontFamily || DEFAULT_STYLE.fontFamily,
      fontSize: Number(parsed.fontSize) || DEFAULT_STYLE.fontSize,
      accent: parsed.accent || DEFAULT_STYLE.accent,
      bg: parsed.bg || DEFAULT_STYLE.bg,
      card: parsed.card || DEFAULT_STYLE.card
    };
  } catch (_error) {
    return { ...DEFAULT_STYLE };
  }
}

function writeStyleInputs(settings) {
  fontFamilyInput.value = settings.fontFamily;
  fontSizeInput.value = String(settings.fontSize);
  accentInput.value = settings.accent;
  bgInput.value = settings.bg;
  cardInput.value = settings.card;
}

function currentStyleFromInputs() {
  return {
    fontFamily: fontFamilyInput.value || DEFAULT_STYLE.fontFamily,
    fontSize: Math.max(10, Math.min(24, Number(fontSizeInput.value) || DEFAULT_STYLE.fontSize)),
    accent: accentInput.value || DEFAULT_STYLE.accent,
    bg: bgInput.value || DEFAULT_STYLE.bg,
    card: cardInput.value || DEFAULT_STYLE.card
  };
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error("Chrome extension runtime is unavailable."));
      return;
    }
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

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function parseImportedJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.logs)) return raw.logs;
  if (raw && raw.data && Array.isArray(raw.data.logs)) return raw.data.logs;
  return [];
}

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("JavaScript error:")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (_error) {
      // Ignore non-JSON lines.
    }
  }
  return out;
}

function normalizeLog(item, idx) {
  const stack = Array.isArray(item?.stack) ? item.stack : [];
  const api = typeof item?.api === "string" ? item.api : "";
  const apiParts = api ? api.split(".") : [];
  const inferredInterface =
    item?.interface || item?.iface || (apiParts.length > 1 ? apiParts[0] : item?.category) || "Unknown";
  const inferredMember =
    item?.member || item?.method || (apiParts.length > 1 ? apiParts.slice(1).join(".") : api || "unknown");

  return {
    seq: Number.isFinite(Number(item?.seq)) ? Number(item.seq) : idx + 1,
    ts: Number.isFinite(Number(item?.ts)) ? Number(item.ts) : Date.now(),
    type: String(item?.type || "call"),
    interface: String(inferredInterface),
    member: String(inferredMember),
    args: Array.isArray(item?.args) ? item.args : item?.args !== undefined ? [item.args] : undefined,
    return: item?.return,
    value: item?.value,
    stack,
    method: item?.method ? String(item.method) : undefined,
    file: item?.file ? String(item.file) : undefined,
    line: item?.line ?? undefined
  };
}

function isNetwork(item) {
  return (
    (item.interface === "Window" && item.member === "fetch") ||
    (item.interface === "XMLHttpRequest" && ["open", "send", "setRequestHeader"].includes(item.member)) ||
    item.interface === "Request" ||
    item.interface === "Response"
  );
}

function isCookie(item) {
  return item.interface === "Document" && item.member.toLowerCase().includes("cookie");
}

function isConsole(item) {
  return item.type === "console" || item.interface === "Console";
}

function isCanvas(item) {
  const methods = CANVAS_INTERFACES[item.interface];
  if (!methods) return false;
  return methods.has(item.member) || methods.size === 0;
}

function toSearchText(item) {
  return [
    item.interface,
    item.member,
    item.type,
    safeJson(item.args || []),
    safeJson(item.value),
    safeJson(item.return),
    safeJson(item.stack || [])
  ]
    .join(" ")
    .toLowerCase();
}

function applyFilters(items) {
  const ifaceNeedle = interfaceFilter.value.trim().toLowerCase();
  const memberNeedle = memberFilter.value.trim().toLowerCase();
  const textNeedle = textFilter.value.trim().toLowerCase();

  return items.filter((item) => {
    if (ifaceNeedle && !item.interface.toLowerCase().includes(ifaceNeedle)) return false;
    if (memberNeedle && !item.member.toLowerCase().includes(memberNeedle)) return false;
    if (textNeedle && !toSearchText(item).includes(textNeedle)) return false;
    return true;
  });
}

function renderSummary(items) {
  const stats = {};
  let networkCount = 0;
  let cookieCount = 0;
  let consoleCount = 0;
  let canvasCount = 0;

  for (const item of items) {
    if (!stats[item.interface]) stats[item.interface] = {};
    stats[item.interface][item.member] = (stats[item.interface][item.member] || 0) + 1;
    if (isNetwork(item)) networkCount += 1;
    if (isCookie(item)) cookieCount += 1;
    if (isConsole(item)) consoleCount += 1;
    if (isCanvas(item)) canvasCount += 1;
  }

  const cards = [
    ["Total", items.length],
    ["Interfaces", Object.keys(stats).length],
    ["Network", networkCount],
    ["Cookie", cookieCount],
    ["Console", consoleCount],
    ["Canvas", canvasCount]
  ];

  summaryPanel.innerHTML = "";
  for (const [label, value] of cards) {
    const card = document.createElement("div");
    card.className = "item";
    card.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    summaryPanel.appendChild(card);
  }
}

function stackToString(item) {
  if (!Array.isArray(item.stack) || item.stack.length === 0) return "";
  const first = item.stack[0];
  if (!first) return "";
  return `${first.func || ""} @ ${first.file || ""}:${first.line || ""}:${first.col || ""}`.trim();
}

function valueForNetwork(item) {
  if (item.args !== undefined) return safeJson(item.args);
  if (item.value !== undefined) return String(item.value);
  if (item.return !== undefined) return String(item.return);
  return "";
}

function valueForCanvas(item) {
  const parts = [];
  if (item.args !== undefined) parts.push(`args: ${safeJson(item.args)}`);
  if (item.return !== undefined) {
    let ret = item.return;
    if (typeof ret === "string" && ret.startsWith("data:image")) {
      ret = `${ret.slice(0, 80)}...[base64]`;
    }
    parts.push(`return: ${String(ret)}`);
  }
  if (item.value !== undefined) parts.push(`value: ${String(item.value)}`);
  return parts.join("\n");
}

function appendCell(tr, text, className = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  tr.appendChild(td);
}

function renderStats(items) {
  const stats = {};
  for (const item of items) {
    if (!stats[item.interface]) stats[item.interface] = {};
    stats[item.interface][item.member] = (stats[item.interface][item.member] || 0) + 1;
  }

  statsBody.innerHTML = "";
  const interfaces = Object.keys(stats).sort((a, b) => a.localeCompare(b));
  if (interfaces.length === 0) {
    const tr = document.createElement("tr");
    appendCell(tr, "No interface calls detected");
    appendCell(tr, "");
    statsBody.appendChild(tr);
    return;
  }

  for (const iface of interfaces) {
    const members = stats[iface];
    const ifaceTotal = Object.values(members).reduce((sum, n) => sum + n, 0);
    const parent = document.createElement("tr");
    appendCell(parent, iface);
    appendCell(parent, String(ifaceTotal));
    statsBody.appendChild(parent);

    const sortedMembers = Object.keys(members).sort((a, b) => a.localeCompare(b));
    for (const member of sortedMembers) {
      const child = document.createElement("tr");
      appendCell(child, `  .${member}`);
      appendCell(child, String(members[member]));
      statsBody.appendChild(child);
    }
  }
}

function renderNetwork(items) {
  const network = items.filter((item) => isNetwork(item) || isCookie(item));
  networkBody.innerHTML = "";
  if (network.length === 0) {
    const tr = document.createElement("tr");
    appendCell(tr, "No network/cookie records");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    networkBody.appendChild(tr);
    return;
  }

  for (const item of network.slice(0, 6000)) {
    const tr = document.createElement("tr");
    appendCell(tr, String(item.seq || ""));
    appendCell(tr, item.type || "");
    appendCell(tr, item.interface || "");
    appendCell(tr, item.member || "");
    appendCell(tr, valueForNetwork(item), "block");
    appendCell(tr, stackToString(item), "block");
    networkBody.appendChild(tr);
  }
}

function renderConsole(items) {
  const consoleLogs = items.filter(isConsole);
  consoleBody.innerHTML = "";
  if (consoleLogs.length === 0) {
    const tr = document.createElement("tr");
    appendCell(tr, "No console logs");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    consoleBody.appendChild(tr);
    return;
  }

  for (const item of consoleLogs.slice(0, 6000)) {
    const tr = document.createElement("tr");
    const method = item.method || item.member || "log";
    const source =
      (item.file ? `${String(item.file).split("/").pop()}:${item.line || ""}` : "") || stackToString(item);
    appendCell(tr, String(item.seq || ""));
    appendCell(tr, method);
    appendCell(tr, safeJson(item.args || []), "block");
    appendCell(tr, source);
    consoleBody.appendChild(tr);
  }
}

function renderCanvas(items) {
  const canvas = items.filter(isCanvas);
  canvasBody.innerHTML = "";
  if (canvas.length === 0) {
    const tr = document.createElement("tr");
    appendCell(tr, "No canvas fingerprint calls");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    appendCell(tr, "");
    canvasBody.appendChild(tr);
    return;
  }

  for (const item of canvas.slice(0, 6000)) {
    const tr = document.createElement("tr");
    appendCell(tr, String(item.seq || ""));
    appendCell(tr, item.interface || "");
    appendCell(tr, item.member || "");
    appendCell(tr, valueForCanvas(item), "block");
    appendCell(tr, stackToString(item), "block");
    canvasBody.appendChild(tr);
  }
}

function switchTab(tabName) {
  activeTab = tabName;
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }
  for (const panel of tabPanels) {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  }
  refreshView();
}

function refreshView() {
  const filtered = applyFilters(logs);
  resultInfo.textContent = `${filtered.length} events shown (${logs.length} loaded)`;

  if (activeTab === "stats") renderStats(filtered);
  if (activeTab === "network") renderNetwork(filtered);
  if (activeTab === "console") renderConsole(filtered);
  if (activeTab === "canvas") renderCanvas(filtered);
}

function setLogs(nextLogs) {
  logs = (nextLogs || []).map((item, idx) => normalizeLog(item, idx));
  renderSummary(logs);
  refreshView();
}

async function loadFromLive() {
  const res = await sendMessage({ type: "ffa-get-logs", scope: "all" });
  if (!res?.ok) throw new Error(res?.error || "Failed to load live logs.");
  setLogs(Array.isArray(res.logs) ? res.logs : []);
}

async function onImportFile(file) {
  const text = await file.text();
  try {
    const raw = JSON.parse(text);
    setLogs(parseImportedJson(raw));
    return;
  } catch (_jsonError) {
    const lines = parseJsonLines(text);
    if (lines.length === 0) {
      throw new Error("Unsupported file format. Expected JSON or JSON lines.");
    }
    setLogs(lines);
  }
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

function exportCurrent() {
  const filtered = applyFilters(logs);
  downloadJson(
    {
      generatedAt: new Date().toISOString(),
      activeTab,
      totalLoaded: logs.length,
      totalFiltered: filtered.length,
      logs: filtered
    },
    `ffa_filtered_${activeTab}_${Date.now()}.json`
  );
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  onImportFile(file).catch((error) => {
    resultInfo.textContent = `Import failed: ${error.message}`;
  });
});

loadLiveBtn.addEventListener("click", () => {
  loadFromLive().catch((error) => {
    resultInfo.textContent = `Live load failed: ${error.message}`;
  });
});

exportBtn.addEventListener("click", exportCurrent);
styleBtn.addEventListener("click", () => {
  stylePanel.classList.toggle("visible");
});
saveStyleBtn.addEventListener("click", () => {
  const settings = currentStyleFromInputs();
  applyStyleSettings(settings);
  localStorage.setItem(STYLE_KEY, JSON.stringify(settings));
});
resetStyleBtn.addEventListener("click", () => {
  writeStyleInputs(DEFAULT_STYLE);
  applyStyleSettings(DEFAULT_STYLE);
  localStorage.setItem(STYLE_KEY, JSON.stringify(DEFAULT_STYLE));
});
interfaceFilter.addEventListener("input", refreshView);
memberFilter.addEventListener("input", refreshView);
textFilter.addEventListener("input", refreshView);

const styleSettings = readStyleSettings();
writeStyleInputs(styleSettings);
applyStyleSettings(styleSettings);
setLogs([]);
