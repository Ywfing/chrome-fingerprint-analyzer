const STORAGE_KEY = "ffa_state_v2";
const MAX_LOGS_PER_TAB = 10000;
const MAX_STACK_DEPTH = 10;

let state = { tabs: {}, seq: {} };
let loaded = false;
let saveTimer = null;

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

async function ensureLoaded() {
  if (loaded) return;
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  if (stored && stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object") {
    state = stored[STORAGE_KEY];
  }
  if (!state.tabs || typeof state.tabs !== "object") state.tabs = {};
  if (!state.seq || typeof state.seq !== "object") state.seq = {};
  loaded = true;
}

async function saveNow() {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow().catch(() => {});
  }, 500);
}

function tabKey(tabId) {
  return Number.isInteger(tabId) ? String(tabId) : "unknown";
}

function nextSeq(key) {
  state.seq[key] = (state.seq[key] || 0) + 1;
  return state.seq[key];
}

function trimStack(stack) {
  if (!Array.isArray(stack)) return [];
  return stack.slice(0, MAX_STACK_DEPTH).map((frame) => ({
    func: String(frame?.func || ""),
    file: String(frame?.file || ""),
    line: Number.isFinite(Number(frame?.line)) ? Number(frame.line) : "",
    col: Number.isFinite(Number(frame?.col)) ? Number(frame.col) : ""
  }));
}

function normalizeLog(key, payload, tabUrl) {
  const interfaceName = String(payload.interface || payload.iface || "Unknown");
  const member = String(payload.member || payload.api || "unknown");
  const logType = String(payload.type || "call");

  const entry = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    ts: Number.isFinite(Number(payload.ts)) ? Number(payload.ts) : Date.now(),
    seq: Number.isFinite(Number(payload.seq)) ? Number(payload.seq) : nextSeq(key),
    type: logType,
    interface: interfaceName,
    member,
    tabId: key,
    tabUrl: String(tabUrl || payload.pageUrl || ""),
    frameUrl: String(payload.frameUrl || ""),
    stack: trimStack(payload.stack)
  };

  if (Array.isArray(payload.args)) {
    entry.args = payload.args;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "return")) {
    entry.return = payload.return;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "value")) {
    entry.value = payload.value;
  }
  if (payload.method) {
    entry.method = String(payload.method);
  }
  if (payload.file) {
    entry.file = String(payload.file);
  }
  if (payload.line !== undefined) {
    entry.line = Number.isFinite(Number(payload.line)) ? Number(payload.line) : String(payload.line);
  }

  return entry;
}

function addLog(tabId, payload, tabUrl) {
  const key = tabKey(tabId);
  if (!Array.isArray(state.tabs[key])) {
    state.tabs[key] = [];
  }

  const entry = normalizeLog(key, payload || {}, tabUrl);
  state.tabs[key].push(entry);
  if (state.tabs[key].length > MAX_LOGS_PER_TAB) {
    state.tabs[key] = state.tabs[key].slice(-MAX_LOGS_PER_TAB);
  }
}

function collectLogs(scope, tabId) {
  if (scope === "tab") {
    const logs = state.tabs[tabKey(tabId)] || [];
    return logs.slice().sort((a, b) => b.ts - a.ts);
  }

  const all = [];
  for (const logs of Object.values(state.tabs)) {
    if (Array.isArray(logs)) all.push(...logs);
  }
  return all.sort((a, b) => b.ts - a.ts);
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
  return item.interface === "Document" && String(item.member).toLowerCase().includes("cookie");
}

function isCanvas(item) {
  const methods = CANVAS_INTERFACES[item.interface];
  if (!methods) return false;
  return methods.has(item.member) || methods.size === 0;
}

function isConsole(item) {
  return item.type === "console" || item.interface === "Console";
}

function summarize(logs) {
  const stats = {};
  let networkCount = 0;
  let cookieCount = 0;
  let consoleCount = 0;
  let canvasCount = 0;

  for (const item of logs) {
    const iface = item.interface || "Unknown";
    const member = item.member || "unknown";
    if (!stats[iface]) stats[iface] = {};
    stats[iface][member] = (stats[iface][member] || 0) + 1;

    if (isNetwork(item)) networkCount += 1;
    if (isCookie(item)) cookieCount += 1;
    if (isConsole(item)) consoleCount += 1;
    if (isCanvas(item)) canvasCount += 1;
  }

  return {
    total: logs.length,
    interfaceCount: Object.keys(stats).length,
    stats,
    networkCount,
    cookieCount,
    consoleCount,
    canvasCount
  };
}

async function clearLogs(scope, tabId) {
  if (scope === "tab") {
    const key = tabKey(tabId);
    delete state.tabs[key];
    delete state.seq[key];
  } else {
    state.tabs = {};
    state.seq = {};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureLoaded();

    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "Invalid message payload." });
      return;
    }

    if (message.type === "ffa-log") {
      addLog(sender.tab?.id, message.payload || {}, sender.tab?.url || "");
      scheduleSave();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ffa-get-logs") {
      const scope = message.scope === "tab" ? "tab" : "all";
      const logs = collectLogs(scope, message.tabId);
      sendResponse({ ok: true, logs, summary: summarize(logs) });
      return;
    }

    if (message.type === "ffa-clear-logs") {
      const scope = message.scope === "tab" ? "tab" : "all";
      await clearLogs(scope, message.tabId);
      scheduleSave();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureLoaded().catch(() => {});
});

chrome.runtime.onSuspend.addListener(() => {
  saveNow().catch(() => {});
});
