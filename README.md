# Chrome FingerPrint Analyzer

Chrome extension with Firefox-FingerPrint-Analyzer style log schema and 4-view analysis.

## Parity Scope (Firefox -> Chrome)

- Log field model aligned:
  - `seq`, `type`, `interface`, `member`, `args`, `return`, `value`, `stack`
- Analysis views aligned:
  - `Statistics`
  - `Network/Cookie`
  - `Console`
  - `Canvas`
- UI settings aligned:
  - font family
  - font size
  - key colors (accent/background/card)
- Compatible import:
  - Exported extension JSON
  - JSON array logs
  - JSON-lines trace logs (one JSON object per line)

## Capture Coverage

- Core DOM/BOM call tracing (broad prototype method wrapping)
- Network/cookie operations:
  - `Window.fetch`
  - `XMLHttpRequest.open/send/setRequestHeader`
  - `Request` / `Response` prototype methods
  - `Document.cookie` get/set
- Console capture:
  - `console.log/info/warn/error/debug/table/trace`
- Canvas fingerprint interfaces and members:
  - `HTMLCanvasElement`, `CanvasRenderingContext2D`, `TextMetrics`
  - `OffscreenCanvas`, `OffscreenCanvasRenderingContext2D`
- Additional fingerprint-related getters:
  - `Navigator.*` and `Screen.*` selected properties

## Install

1. Open `chrome://extensions` in Google Chrome.
2. Enable `Developer mode` (top-right).
3. Click `Load unpacked`.
4. Select this folder: `chrome-fingerprint-analyzer`.

## How It Works

- `content.js` injects `injected.js` into each page.
- `injected.js` hooks DOM/BOM/network/canvas/console APIs in page context.
- Hook events are sent to `background.js`.
- `background.js` stores logs in `chrome.storage.session`.
- `popup.html` and `analyzer.html` read logs through runtime messages and apply Firefox-style categorization rules.

## Output Format

Exported JSON structure:

```json
{
  "generatedAt": "2026-04-10T00:00:00.000Z",
  "scope": "tab",
  "tabId": 123,
  "logs": [
    {
      "id": "1712700000000_abcdef12",
      "ts": 1712700000000,
      "tabId": "123",
      "tabUrl": "https://example.com",
      "frameUrl": "https://example.com",
      "type": "call",
      "interface": "HTMLCanvasElement",
      "member": "toDataURL",
      "args": [],
      "return": "data:image/png;base64,...",
      "stack": [
        {
          "func": "anonymous",
          "file": "https://example.com/script.js",
          "line": 123,
          "col": 45
        }
      ]
    }
  ]
}
```

## Notes and Limits

- This is an in-browser hook approach, not the same low-level Firefox DOM trace pipeline.
- Chromium non-configurable properties/methods cannot be wrapped and are skipped.
- High-traffic pages can generate large logs; per-tab logs are capped at `10000`.
