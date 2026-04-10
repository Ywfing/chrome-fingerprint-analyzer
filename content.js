(() => {
  if (!document.documentElement) return;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;
  script.setAttribute("data-ffa-injected", "1");
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  window.addEventListener(
    "message",
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "__FFA__" || data.type !== "event") return;

      try {
        chrome.runtime.sendMessage({
          type: "ffa-log",
          payload: {
            ...data.payload,
            frameUrl: window.location.href
          }
        }, () => {
          void chrome.runtime.lastError;
        });
      } catch (_error) {
        // Ignore message transport failures to avoid impacting page scripts.
      }
    },
    true
  );
})();
