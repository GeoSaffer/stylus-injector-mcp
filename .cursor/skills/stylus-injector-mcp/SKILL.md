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

## START HERE — THE MCP IS ALREADY RUNNING

**Step 1 — Call `get_current_theme` right now.** Read the response before doing anything else.

```
get_current_theme()
```

**Step 2 — Branch based on what you see:**

**If a proxy is already active** (targets list is not empty):
→ The proxy is running. Do NOT call `start_proxy` again.
→ Check if the target matches what the user wants. If yes, go straight to themes.
→ If the target is wrong: call `stop_proxy`, then start the correct one.

**If no proxy is active** (targets list is empty):
→ Call `list_userstyles` to find the theme files.
→ Call `start_proxy` with the correct target.
→ Navigate the browser to the proxy.
→ THEN switch to the theme.

**Do not touch the theme until the proxy is confirmed running with the right target.**
A theme switch before `start_proxy` has no visible effect — the proxy has to be running first for CSS to be injected into pages.

Do not kill anything. Do not restart anything. Just call `get_current_theme` and branch.

---

## ARCHITECTURE — READ THIS FIRST

There are two distinct layers. Confusing them causes every common mistake.

```
┌─────────────────────────────────────────────────────┐
│  MCP SERVER PROCESS (stylus-injector)               │
│  Always running. Cursor manages it. NEVER touch it. │
│                                                     │
│  Inside it runs an HTTP server on :9988             │
│  which acts as the reverse proxy.                   │
└─────────────────────────────────────────────────────┘
         ▲
         │  You talk to it using MCP tools only:
         │  start_proxy, stop_proxy, switch_theme, etc.
         ▼
┌─────────────────────────────────────────────────────┐
│  HTTP REVERSE PROXY (inside the MCP process)        │
│  localhost:9988 → your target site                  │
│  Controlled entirely by the MCP tools below.        │
│  start_proxy activates it. stop_proxy clears it.    │
│  The MCP process itself keeps running either way.   │
└─────────────────────────────────────────────────────┘
```

**The MCP process is Cursor's responsibility. You do not start it, stop it, restart it, or kill it. Ever.**

If something is not working, fix it by calling the right MCP tool — not by touching processes.

---

## NEVER DO THESE THINGS — NO EXCEPTIONS

These actions are wrong even if the proxy seems broken, even if a tool returns an error, even if you think the server needs restarting. There is no situation where these are correct.

- **NEVER kill, stop, or restart the MCP process** — Cursor manages it, it is already running
- **NEVER tell the user to reload MCP servers, restart Cursor, or kill a port**
- **NEVER run shell commands to manage processes**: `netstat`, `tasklist`, `taskkill`, `kill`, `Stop-Process`, `Get-Process` — none of these
- **NEVER restart or reset the proxy by any means other than calling `stop_proxy` then `start_proxy`**
- **NEVER ask the user to reload the page** — changes go live automatically via SSE
- **NEVER guess a file path** — always use the `path` value returned by `list_userstyles`

If you think the MCP is broken: call `get_current_theme`. That is the diagnostic. Nothing else.

---

## When something is wrong — fix it with tools, in this order

1. Call `get_current_theme` — read what is actually active. This is the only diagnostic you need.
2. If the proxy is running but styles look wrong: call `refresh_theme`.
3. If the wrong theme is loaded: call `switch_theme` with the correct path.
4. If the proxy is pointing at the wrong target: call `stop_proxy`, then `start_proxy` with the correct one.
5. If no proxy is running at all: call `list_userstyles`, then `start_proxy`, then `switch_theme`.

That is the entire troubleshooting checklist. Do not go further. Do not touch processes.

---

## Scenario A — Set a theme folder, then browse and switch freely

This is the primary workflow. Scan the folder once, start the proxy, then switch themes freely.

**Step 1 — Scan the folder**

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

Always use the `path` field in every subsequent call. Never use `name` or `file`.

**Step 2 — Start the proxy**

```
start_proxy({ target: "https://example.com" })
```

`userstyle` is optional here. You can start without a theme and switch to one after.

**Step 3 — Navigate the browser**

Call the browser tool yourself. Do not tell the user to do it.

```
browser_navigate({ url: "http://localhost:9988/" })
```

**Step 4 — Apply a theme**

```
switch_theme({ userstyle: "C:/Users/dave/themes/dark.user.css" })
```

**Step 5 — Switch to another theme at any time**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

The browser updates instantly every time. No reload needed.

---

## Scenario B — Start with a specific theme already loaded

```
start_proxy({
  target: "https://example.com",
  userstyle: "C:/Users/dave/themes/dark.user.css"
})
```

Still call `list_userstyles` first to get the correct `path`.

---

## Scenario C — Switch theme while proxy is running

**Step 1 — Check what is active**

```
get_current_theme()
```

**Step 2 — Switch**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

The browser updates instantly. Do not ask the user to reload.

**Step 3 — Clear theme entirely (optional)**

```
switch_theme({ userstyle: "" })
```

---

## Scenario D — Writing CSS for a third-party site

Always inspect real class names before writing CSS. Generic names like `.card` or `main` almost never exist on third-party sites.

Fetch the proxied HTML and extract selectors:

**macOS / Linux**
```bash
curl -s "http://localhost:9988/" | grep -oE '<body[^>]*>' | head -1
curl -s "http://localhost:9988/" | grep -oE '<div[^>]+class="[^"]{10,60}"' | head -20
```

**Windows (PowerShell)**
```powershell
$html = (Invoke-WebRequest "http://localhost:9988/" -UseBasicParsing).Content
[regex]::Match($html, '<body[^>]*>').Value
[regex]::Matches($html, '<div[^>]+class="[^"]{10,60}"') | Select-Object -First 20 | ForEach-Object { $_.Value }
```

Write CSS using the real class names found, save the file, then:

```
switch_theme({ userstyle: "C:/path/to/your-theme.user.css" })
```

---

## Scenario E — User hasn't said where their themes are

Ask: *"What folder are your `.user.css` theme files in?"*

Once they give the path, run `list_userstyles`, then continue as Scenario A.

---

## Scenario F — Inject a one-off CSS snippet without a file

```
inject_css({
  css: "body { background: #0f0f17 !important; font-size: 16px !important; }",
  id: "my-tweak"
})
```

- Reuse the same `id` to replace the previous snippet.
- Snippets stack on top of the active theme, they don't replace it.

---

## Scenario G — Styles not visually applying

Call this. Do not ask the user to reload.

```
refresh_theme()
```

Cycles the theme off → waits 50 ms → back on. Forces full style recalculation.

---

## Scenario H — Site redirects to a different domain during login

Some sites (e.g. Skilljar) redirect to an auth subdomain on login. Without proxying that subdomain too, the browser escapes the proxy tunnel and theming stops.

Register every domain the site redirects to **before** navigating.

**Step 1 — Start the primary proxy**

```
start_proxy({ target: "https://skilljar.com" })
```

**Step 2 — Add the auth subdomain immediately**

```
add_target({ target: "https://accounts.skilljar.com" })
```

Response:
```
Target added: http://localhost:9989 → https://accounts.skilljar.com

All active proxies:
  http://localhost:9988 → https://skilljar.com
  http://localhost:9989 → https://accounts.skilljar.com
```

**Step 3 — Navigate**

```
browser_navigate({ url: "http://localhost:9988/" })
```

Login redirects to `accounts.skilljar.com` are automatically rewritten to `localhost:9989`. The browser stays proxied. All proxies share the same theme.

**Step 4 — List active proxies**

```
list_targets()
```

**Step 5 — Remove when done (optional)**

```
remove_target({ target: "https://accounts.skilljar.com" })
```

---

## `.user.css` file format

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

The proxy strips the metadata block automatically — only the raw CSS is injected.

---

## Tool reference

| Tool | Required params | Notes |
|---|---|---|
| `list_userstyles` | `directory` | Scan folder for `.user.css` files. Returns `{ file, path, name, version }` per theme. Always call first. Always use `path` in subsequent calls. |
| `start_proxy` | `target` | Full origin e.g. `https://example.com`. `userstyle` optional. |
| `add_target` | `target` | Add another domain on its own auto-assigned port (9989+). All proxies share the same theme. Use for auth subdomains. |
| `remove_target` | `port` or `target` | Remove a proxy target by port number or origin URL. |
| `list_targets` | — | List all active proxy targets. |
| `switch_theme` | `userstyle` | Absolute path to `.user.css`, or `""` to clear. Hot-swaps live. |
| `refresh_theme` | — | Force re-render when styles aren't applying visually. |
| `inject_css` | `css` | Raw CSS snippet on top of the active theme. Optional `id` to replace. |
| `get_current_theme` | — | Returns active theme name, file path, and all proxy targets. |
| `stop_proxy` | — | Stop all proxies and clear state. MCP server keeps running. |

---

## Rules

1. **Always call `get_current_theme` first** — check if a proxy is already running before doing anything.
2. **Do not touch themes until the proxy is running** — `switch_theme` before `start_proxy` has no visible effect.
3. **Call `list_userstyles` before `start_proxy`** — you need the `path` values; never guess or hardcode file paths.
4. **Always use `path`** from `list_userstyles` results — never use `name` or `file`.
5. **If a proxy is already running with the right target, do not call `start_proxy` again** — go straight to themes.
6. **Navigate the browser yourself** with `browser_navigate({ url: "http://localhost:9988/" })` — do not tell the user to do it.
7. **After `switch_theme` or `inject_css` the change is live** — do not ask the user to reload.
8. **If styles aren't showing**, call `refresh_theme()` — do not ask the user to reload.
9. **Inspect real HTML before writing CSS** — use the snippet in Scenario D.
10. **Register auth subdomains before navigating** — call `add_target` for every domain the site may redirect to, before the user starts a session.
11. **The MCP is already running when you read this** — do not start, stop, restart, or kill it. Call `get_current_theme` and branch from there.
