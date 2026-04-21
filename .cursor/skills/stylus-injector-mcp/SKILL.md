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

## How to use this MCP

### Step 1 — Always call `get_current_theme` first

```
get_current_theme()
```

This is the only diagnostic you need. It returns the active theme, file path, and all proxy targets. Read the response before you do anything else.

### Step 2 — Branch based on the response

| State you see | Branch to follow |
|---|---|
| Proxy is running with the target the user wants | Go to **Scenario 1** (switch or apply theme) |
| Proxy is running but targeting the wrong site | Go to **Scenario 2** (replace target) |
| No proxy running at all | Go to **Scenario 3** (full startup) |
| User wants to log in to a site that redirects to an auth subdomain | Go to **Scenario 4** (multi-domain) |
| Styles loaded but not rendering | Call `refresh_theme()` and stop |
| Writing CSS for a third-party site | Go to **Scenario 5** (inspect HTML) |
| User wants a one-off CSS tweak without editing a file | Call `inject_css` directly |

### Architecture — one line you need to know

Cursor runs the MCP process. Inside it is an HTTP proxy on `localhost:9988`. **You control only the HTTP proxy, via the MCP tools listed below.** The MCP process itself is not yours to touch.

---

## Hard rules — no exceptions

These are wrong every time, in every situation, even if a tool returns an error.

- **NEVER kill, stop, or restart the MCP process.** Cursor manages it.
- **NEVER run shell commands to manage processes:** `netstat`, `tasklist`, `taskkill`, `kill`, `Stop-Process`, `Get-Process`.
- **NEVER tell the user to reload MCP servers, restart Cursor, or free a port.**
- **The only way to reset the proxy is `stop_proxy` then `start_proxy`.** No other method is valid.
- **NEVER ask the user to reload the page.** Theme changes apply live via SSE.
- **NEVER guess a file path.** Use the `path` field from `list_userstyles`.
- **NEVER skip Step 1.** Call `get_current_theme` first, always.
- **Do not call `start_proxy` if one is already running with the target the user wants.** Go straight to themes.

If anything seems wrong: call `get_current_theme`. That is the diagnostic. Nothing else.

---

## Tool reference

| Tool | Required params | When to use |
|---|---|---|
| `get_current_theme` | — | **Call this first, every session.** Returns active theme + all proxy targets. Your entire decision tree hinges on this. |
| `list_userstyles` | `directory` | Scan a themes folder. Returns `{ file, path, name, version }` per theme. Call this only when you need to discover theme files — not as a warm-up. Always use the returned `path` value, never `name` or `file`. |
| `start_proxy` | `target`, `userstyle` (optional) | Activate the reverse proxy for a domain. `userstyle` lets you load a theme atomically at startup — fine to use. Do not call if a proxy is already running with the correct target. |
| `add_target` | `target`, `port` (optional) | Add another domain on its own port (auto-assigned from 9989+). All proxies share the same theme. Use for auth subdomains and any domain the site may redirect to. |
| `list_targets` | — | List all active proxy targets. |
| `remove_target` | `port` or `target` | Remove a proxy target by port or origin URL. |
| `switch_theme` | `userstyle` | Absolute path to `.user.css`, or `""` to clear. Hot-swaps live across all proxies. No page reload needed. |
| `refresh_theme` | — | Force re-render when styles aren't rendering visually. Cycles theme off → 50ms → back on. |
| `inject_css` | `css`, `id` (optional) | Raw CSS snippet on top of the active theme. Reuse the same `id` to replace. Stacks on top of the theme, doesn't replace it. |
| `stop_proxy` | — | Stop all proxies, clear theme. The MCP process itself keeps running. |

---

## Scenario 1 — Proxy already running with the right target, switch or apply a theme

`get_current_theme` showed the correct target is active. Do NOT call `start_proxy`.

**If you already have the theme's `path`** (user gave it to you, or an earlier `list_userstyles` returned it):

```
switch_theme({ userstyle: "C:/Users/dave/themes/dark.user.css" })
```

Done. The browser updates live.

**If you don't have the path yet:**

```
list_userstyles({ directory: "C:/Users/dave/themes" })
switch_theme({ userstyle: "<path value from response>" })
```

**To clear the theme:**

```
switch_theme({ userstyle: "" })
```

---

## Scenario 2 — Proxy running, but wrong target

```
stop_proxy()
```

Then go to Scenario 3.

---

## Scenario 3 — Full startup (no proxy running)

**Step 1 — Make sure you know the themes folder.** If the user hasn't said, ask: *"What folder are your `.user.css` theme files in?"*

**Step 2 — Scan the folder to get theme paths:**

```
list_userstyles({ directory: "C:/Users/dave/themes" })
```

Response:
```json
{
  "files": [
    { "file": "dark.user.css", "path": "C:/Users/dave/themes/dark.user.css", "name": "Dark Theme", "version": "1.2" }
  ]
}
```

Always use the `path` field in every subsequent call.

**Step 3 — Start the proxy.** You may pass a theme in at the same time, or start without one:

```
start_proxy({ target: "https://example.com" })
// OR, atomically with a theme:
start_proxy({ target: "https://example.com", userstyle: "C:/Users/dave/themes/dark.user.css" })
```

**Step 4 — Navigate the browser yourself:**

```
browser_navigate({ url: "http://localhost:9988/" })
```

Do not ask the user to navigate.

**Step 5 — If you didn't load a theme in Step 3, load one now:**

```
switch_theme({ userstyle: "C:/Users/dave/themes/dark.user.css" })
```

**Step 6 — Switch to any other theme at any time, instantly:**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

---

## Scenario 4 — Site redirects to an auth subdomain on login

Some sites (e.g. Skilljar) redirect to a different domain during sign-in. Without proxying that domain too, the browser escapes the proxy tunnel and theming stops.

**Step 1 — If no primary proxy is running**, start it (Scenario 3). If it's already running with the main domain, skip to Step 2.

**Step 2 — Add every auth/redirect domain BEFORE the user logs in:**

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

Repeat `add_target` for every redirect domain.

**Step 3 — Navigate to the primary proxy:**

```
browser_navigate({ url: "http://localhost:9988/" })
```

Login redirects are automatically rewritten to `localhost:998x`. All proxies share the same theme — you only switch themes once.

**Step 4 — Remove a target when done (optional):**

```
remove_target({ target: "https://accounts.skilljar.com" })
```

---

## Scenario 5 — Writing CSS for a third-party site

Real class names on third-party sites are almost never `.card`, `main`, `.container`. Generic selectors silently do nothing. Inspect the actual HTML being served before writing CSS.

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

These are read-only inspections of HTTP responses. They are allowed. The hard rules above forbid process-management commands, not HTTP inspection.

Write CSS using the real class names found, save the file, then apply:

```
switch_theme({ userstyle: "C:/path/to/your-theme.user.css" })
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

## Quick reference — the full rule list

1. Call `get_current_theme` first, every session.
2. Branch from the decision tree before touching any other tool.
3. Do not call `start_proxy` if one is already running with the correct target.
4. Use the `path` field from `list_userstyles` — never `name`, never `file`, never a guessed path.
5. Navigate the browser yourself with `browser_navigate` — do not tell the user.
6. After `switch_theme` or `inject_css` the change is live — do not ask the user to reload.
7. If styles aren't rendering visually, call `refresh_theme`.
8. Inspect real HTML before writing CSS for third-party sites (Scenario 5).
9. Register auth subdomains with `add_target` before the user logs in (Scenario 4).
10. Never touch the MCP process. Never run process-management shell commands. The only way to reset the proxy is `stop_proxy` + `start_proxy`.
