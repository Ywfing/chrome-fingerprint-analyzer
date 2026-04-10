(() => {
  const CHANNEL = "__FFA__";
  const MAX_STACK = 10;
  let seq = 0;

  function serialize(value, depth = 0, seen = new WeakSet()) {
    if (depth > 3) return "[DepthLimit]";
    if (value === null || value === undefined) return value;

    const t = typeof value;
    if (t === "string") return value.length > 320 ? `${value.slice(0, 320)}...` : value;
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return `${value.toString()}n`;
    if (t === "symbol") return value.toString();
    if (t === "function") return `[Function ${value.name || "anonymous"}]`;

    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (typeof Promise !== "undefined" && value instanceof Promise) {
      return "[Promise]";
    }
    if (typeof Element !== "undefined" && value instanceof Element) {
      const id = value.id ? `#${value.id}` : "";
      const cls = value.className ? `.${String(value.className).replace(/\s+/g, ".")}` : "";
      return `<${value.tagName.toLowerCase()}${id}${cls}>`;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 16).map((item) => serialize(item, depth + 1, seen));
    }
    if (t === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);

      const ctorName = value?.constructor?.name || "Object";
      if (ctorName !== "Object") return `[${ctorName}]`;

      const out = {};
      const keys = Object.keys(value).slice(0, 16);
      for (const key of keys) {
        try {
          const desc = Object.getOwnPropertyDescriptor(value, key);
          if (desc && typeof desc.get === "function") {
            out[key] = "[Getter]";
          } else {
            out[key] = serialize(value[key], depth + 1, seen);
          }
        } catch (_error) {
          out[key] = "[Unreadable]";
        }
      }
      return out;
    }
    return String(value);
  }

  function parseStackLine(line) {
    const withFunc = /^at\s+(.*?)\s+\((.*):(\d+):(\d+)\)$/;
    const noFunc = /^at\s+(.*):(\d+):(\d+)$/;

    let m = line.match(withFunc);
    if (m) {
      return {
        func: m[1] || "",
        file: m[2] || "",
        line: Number(m[3]) || "",
        col: Number(m[4]) || ""
      };
    }
    m = line.match(noFunc);
    if (m) {
      return {
        func: "",
        file: m[1] || "",
        line: Number(m[2]) || "",
        col: Number(m[3]) || ""
      };
    }
    return null;
  }

  function captureStack() {
    const raw = new Error().stack;
    if (!raw) return [];
    const lines = raw.split("\n").slice(1);
    const stack = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.includes("injected.js") || trimmed.includes("chrome-extension://")) {
        continue;
      }
      const frame = parseStackLine(trimmed);
      if (!frame) continue;
      stack.push(frame);
      if (stack.length >= MAX_STACK) break;
    }
    return stack;
  }

  function emit(payload) {
    try {
      window.postMessage({ source: CHANNEL, type: "event", payload }, "*");
    } catch (_error) {
      // Logging must never break page code.
    }
  }

  function logCall(interfaceName, member, args, ret) {
    emit({
      seq: ++seq,
      ts: Date.now(),
      type: "call",
      interface: interfaceName,
      member,
      args: serialize(args),
      return: serialize(ret),
      stack: captureStack()
    });
  }

  function logGet(interfaceName, member, value) {
    emit({
      seq: ++seq,
      ts: Date.now(),
      type: "get",
      interface: interfaceName,
      member,
      value: serialize(value),
      stack: captureStack()
    });
  }

  function logSet(interfaceName, member, value) {
    emit({
      seq: ++seq,
      ts: Date.now(),
      type: "set",
      interface: interfaceName,
      member,
      value: serialize(value),
      stack: captureStack()
    });
  }

  function logConsole(method, args) {
    const stack = captureStack();
    const first = stack[0] || {};
    emit({
      seq: ++seq,
      ts: Date.now(),
      type: "console",
      interface: "Console",
      member: method,
      method,
      args: serialize(args),
      file: first.file || "",
      line: first.line || "",
      stack
    });
  }

  function wrapMethod(target, methodName, interfaceName, alias = methodName) {
    if (!target) return;
    const desc = Object.getOwnPropertyDescriptor(target, methodName);
    if (!desc || typeof desc.value !== "function") return;
    const original = desc.value;
    if (original.__ffa_wrapped__) return;

    const wrapped = function (...args) {
      try {
        const ret = original.apply(this, args);
        logCall(interfaceName, alias, args, ret);
        return ret;
      } catch (error) {
        logCall(interfaceName, `${alias}:throw`, args, error);
        throw error;
      }
    };

    Object.defineProperty(wrapped, "__ffa_wrapped__", { value: true });
    try {
      Object.defineProperty(target, methodName, {
        value: wrapped,
        writable: desc.writable,
        enumerable: desc.enumerable,
        configurable: desc.configurable
      });
    } catch (_error) {
      // Non-configurable methods cannot be patched.
    }
  }

  function wrapAccessor(proto, propName, interfaceName, options = {}) {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, propName);
    if (!desc || desc.configurable !== true) return;
    if (desc.get && desc.get.__ffa_wrapped__) return;

    const newDesc = { configurable: true, enumerable: desc.enumerable };

    if (typeof desc.get === "function") {
      const originalGet = desc.get;
      const wrappedGet = function () {
        const value = originalGet.call(this);
        logGet(interfaceName, options.getName || propName, value);
        return value;
      };
      Object.defineProperty(wrappedGet, "__ffa_wrapped__", { value: true });
      newDesc.get = wrappedGet;
    }

    if (typeof desc.set === "function") {
      const originalSet = desc.set;
      const wrappedSet = function (value) {
        logSet(interfaceName, options.setName || `set ${propName}`, value);
        return originalSet.call(this, value);
      };
      Object.defineProperty(wrappedSet, "__ffa_wrapped__", { value: true });
      newDesc.set = wrappedSet;
    }

    if (!newDesc.get && !newDesc.set) return;
    try {
      Object.defineProperty(proto, propName, newDesc);
    } catch (_error) {
      // Skip protected properties.
    }
  }

  function wrapMethodList(proto, interfaceName, methods) {
    if (!proto || !Array.isArray(methods)) return;
    for (const name of methods) {
      wrapMethod(proto, name, interfaceName);
    }
  }

  function wrapAccessorList(proto, interfaceName, props, options = {}) {
    if (!proto || !Array.isArray(props)) return;
    for (const name of props) {
      wrapAccessor(proto, name, interfaceName, options);
    }
  }

  function wrapAllOwnMethods(proto, interfaceName) {
    if (!proto) return;
    const names = Object.getOwnPropertyNames(proto);
    for (const name of names) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== "function") continue;
      wrapMethod(proto, name, interfaceName, name);
    }
  }

  function protoOf(name) {
    const ctor = globalThis[name];
    return ctor && ctor.prototype ? ctor.prototype : null;
  }

  function patchConsole() {
    if (!window.console) return;
    const methods = ["log", "info", "warn", "error", "debug", "table", "trace"];
    for (const method of methods) {
      const original = window.console[method];
      if (typeof original !== "function" || original.__ffa_wrapped__) continue;
      const wrapped = function (...args) {
        logConsole(method, args);
        return original.apply(this, args);
      };
      Object.defineProperty(wrapped, "__ffa_wrapped__", { value: true });
      window.console[method] = wrapped;
    }
  }

  function patchCookie() {
    wrapAccessor(protoOf("Document"), "cookie", "Document", {
      getName: "cookie",
      setName: "set cookie"
    });
  }

  function patchCoreApis() {
    wrapMethod(window, "fetch", "Window");
    wrapMethodList(protoOf("XMLHttpRequest"), "XMLHttpRequest", ["open", "send", "setRequestHeader"]);
    wrapMethodList(protoOf("Navigator"), "Navigator", ["sendBeacon"]);
    wrapMethodList(protoOf("Storage"), "Storage", ["getItem", "setItem", "removeItem", "clear", "key"]);
    wrapMethodList(protoOf("History"), "History", ["pushState", "replaceState", "back", "forward", "go"]);
    wrapMethodList(protoOf("Performance"), "Performance", ["now", "getEntries", "getEntriesByType", "mark", "measure"]);
    wrapMethodList(protoOf("CSSStyleDeclaration"), "CSSStyleProperties", ["setProperty", "removeProperty"]);

    wrapMethodList(protoOf("HTMLCanvasElement"), "HTMLCanvasElement", ["toDataURL", "getContext", "toBlob"]);
    wrapMethodList(protoOf("CanvasRenderingContext2D"), "CanvasRenderingContext2D", [
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
    ]);
    wrapAccessorList(protoOf("TextMetrics"), "TextMetrics", [
      "width",
      "actualBoundingBoxAscent",
      "actualBoundingBoxDescent",
      "actualBoundingBoxLeft",
      "actualBoundingBoxRight",
      "fontBoundingBoxAscent",
      "fontBoundingBoxDescent"
    ]);
    wrapMethodList(protoOf("OffscreenCanvas"), "OffscreenCanvas", ["getContext", "convertToBlob"]);
    wrapMethodList(protoOf("OffscreenCanvasRenderingContext2D"), "OffscreenCanvasRenderingContext2D", [
      "fillText",
      "strokeText",
      "getImageData"
    ]);

    wrapAllOwnMethods(protoOf("Request"), "Request");
    wrapAllOwnMethods(protoOf("Response"), "Response");

    wrapAllOwnMethods(protoOf("WebGLRenderingContext"), "WebGLRenderingContext");
    wrapAllOwnMethods(protoOf("WebGL2RenderingContext"), "WebGL2RenderingContext");
  }

  function patchFingerprintGetters() {
    wrapAccessorList(protoOf("Navigator"), "Navigator", [
      "userAgent",
      "platform",
      "language",
      "languages",
      "hardwareConcurrency",
      "deviceMemory",
      "webdriver",
      "plugins",
      "mimeTypes",
      "maxTouchPoints"
    ]);
    wrapAccessorList(protoOf("Screen"), "Screen", [
      "width",
      "height",
      "availWidth",
      "availHeight",
      "colorDepth",
      "pixelDepth"
    ]);
  }

  function patchBroadDomBom() {
    wrapAllOwnMethods(protoOf("Document"), "Document");
    wrapAllOwnMethods(protoOf("Node"), "Node");
    wrapAllOwnMethods(protoOf("Element"), "Element");
    wrapAllOwnMethods(protoOf("URLSearchParams"), "URLSearchParams");
    wrapAllOwnMethods(protoOf("BaseAudioContext"), "BaseAudioContext");
    wrapAllOwnMethods(protoOf("AnalyserNode"), "AnalyserNode");
    wrapAllOwnMethods(protoOf("AudioBuffer"), "AudioBuffer");
  }

  try {
    patchConsole();
    patchCookie();
    patchCoreApis();
    patchFingerprintGetters();
    patchBroadDomBom();
    logCall("System", "inject.ready", [location.href], true);
  } catch (error) {
    logCall("System", "inject.error", [], error);
  }
})();
