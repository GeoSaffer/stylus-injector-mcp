---
name: stylus-injector-mcp
description: >-
  Controls the Stylus Injector MCP — a local reverse proxy that injects
  Stylus .user.css themes into any website viewed in the Cursor embedded
  browser. Handles starting/stopping the proxy, switching themes live (no page
  reload), injecting ad-hoc CSS snippets, scanning for theme files, and forcing
  CSS re-renders. Use when the user asks to preview a website with a theme,
  style a site, switch themes, inject CSS, or mentions stylus-injector, the
  proxy panel, theme injection, or .user.css files.
---

# Stylus Injector MCP

Reverse proxy on `localhost:9988` — injects `.user.css` themes into every HTML page. Changes hot-swap live via SSE; no page reload needed.

---

## Scenario A — Start fresh with a theme

**Step 1: Find available themes**

```
list_userstyles({ directory: "C:/Users/dave/themes" })
```

Response:
```json
{
  "files": [
    { "file": "dark.user.css", "path": "C:/Users/dave/themes/dark.user.css", "name": "Dark Theme", "version": "1.2" },
    { "file": "blue.user.css", "path": "C:/Users/dave/themes/blue.user.css", "name": "Blue Slate",  "version": "1.0" }
  ]
}
```

> **IMPORTANT:** Always use the `path` field — the full absolute path — when passing a theme to any tool. Never use `name` or `file`.

**Step 2: Start the proxy with a theme**

```
start_proxy({
  target: "https://example.com",
  userstyle: "C:/Users/dave/themes/dark.user.css"
})
```

**Step 3: Navigate the browser to the proxy**

Use the browser tool directly — do not just tell the user:

```
browser_navigate({ url: "http://localhost:9988/" })
```

---

## Scenario B — Switch theme while proxy is running

**Step 1: Check what is currently active**

```
get_current_theme()
```

**Step 2: Switch to a different theme using the `path` from `list_userstyles`**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

The browser updates **instantly** — do not ask the user to reload.

**Step 3: Clear the theme entirely (optional)**

```
switch_theme({ userstyle: "" })
```

---

## Scenario C — Writing CSS for a third-party site

**Always inspect real class names before writing CSS.** Generic selectors like `.card` or `main` rarely exist on third-party sites. Guessing silently does nothing.

After the proxy is running, fetch the proxied HTML and extract real selectors:

```powershell
$r = Invoke-WebRequest "http://localhost:9988/" -UseBasicParsing
$html = $r.Content

# Check the body tag
[regex]::Match($html, '<body[^>]*>').Value

# Find meaningful div class names
[regex]::Matches($html, '<div[^>]+class="[^"]{10,60}"') |
  Select-Object -First 20 |
  ForEach-Object { $_.Value }
```

Write CSS using the real class names found, then apply:

```
switch_theme({ userstyle: "C:/path/to/your-theme.user.css" })
```

---

## Scenario D — User hasn't said where their themes are

Ask: *"What folder are your `.user.css` theme files in?"*

Once they give the path, run `list_userstyles` with it, then proceed as Scenario A.

---

## Scenario E — Inject one-off CSS without a theme file

```
inject_css({
  css: "body { background: #0f0f17 !important; font-size: 16px !important; }",
  id: "my-tweak"
})
```

- Reusing the same `id` replaces the previous snippet — good for iterating.
- Snippets stack **on top of** the theme — they don't replace it.

---

## Scenario F — Styles not visually updating

```
refresh_theme()
```

Cycles the theme off → waits 50 ms → back on. Forces full style recalculation. **Do not ask the user to reload the page.**

---

## Scenario G — Proxy appears active but CSS is not injecting

A stale Node.js process from a previous session may be holding port `9988`. Check:

```powershell
netstat -ano | findstr ":9988"
```

If the PID is from an old process, kill it and reload MCP servers in Cursor (Settings → MCP → Reload on `stylus-injector`).

---

## `.user.css` file format

Every theme file must have a `==UserStyle==` metadata block at the top:

```css
/* ==UserStyle==
@name         My Theme Name
@description  What this theme does
@version      1.0.0
@author       Your Name
@match        *://example.com/*
==/UserStyle== */

/* CSS rules below — this is what gets injected */
body { background: #111 !important; }
```

The proxy strips the metadata block automatically — only the raw CSS rules are injected.

---

## Tool reference

| Tool | Required params | Notes |
|---|---|---|
| `list_userstyles` | `directory` | Returns `{ file, path, name, version }` per theme. Always use `path` in subsequent calls. |
| `start_proxy` | `target` | `target` = full origin e.g. `https://example.com`. `userstyle` = absolute `path` from `list_userstyles`. |
| `switch_theme` | `userstyle` | Absolute path to `.user.css`, or `""` to clear. Hot-swaps live. |
| `refresh_theme` | — | Force re-render. Use when styles aren't applying visually. |
| `inject_css` | `css` | Raw CSS string. Optional `id` to replace a previous snippet. |
| `get_current_theme` | — | Returns active theme name + file path + proxy target. Always call before switching. |
| `stop_proxy` | — | Stops proxy. Panel stays up at `/__panel__`. |

---

## Rules

1. **Always use `path`** from `list_userstyles` — never guess or hardcode a file path.
2. **Always call `get_current_theme`** before switching so you know the current state.
3. **If you don't know the theme directory**, ask the user before calling any tool.
4. **Navigate the browser yourself** using `browser_navigate({ url: "http://localhost:9988/" })` — do not just tell the user to do it.
5. **After `switch_theme` or `inject_css` the change is already live** — do not ask the user to reload.
6. **If styles aren't showing**, call `refresh_theme()` — do not ask the user to reload.
7. **Inspect real HTML before writing CSS** — use the PowerShell snippet in Scenario C to find actual class names.
