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

## Scenario A — Set a theme folder, then browse and switch freely

This is the preferred workflow when the user has a folder of themes. Scan the folder once to register it, start the proxy without locking in a theme, then switch freely.

**Step 1: Scan the folder to discover all available themes**

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

Keep the `files` array in memory for this session — you will use `path` values to switch themes.

**Step 2: Start the proxy (no theme required yet)**

```
start_proxy({ target: "https://example.com" })
```

`userstyle` is optional. You can start without a theme and apply one after.

**Step 3: Navigate the browser to the proxy**

Use the browser tool directly — do not just tell the user:

```
browser_navigate({ url: "http://localhost:9988/" })
```

**Step 4: Apply any theme from the folder using its `path`**

```
switch_theme({ userstyle: "C:/Users/dave/themes/dark.user.css" })
```

**Step 5: Switch to any other theme in the folder at any time**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

The browser updates **instantly** every time — no reload needed.

---

## Scenario B — Start with a specific theme already loaded

If the user wants a particular theme active from the moment the proxy starts:

```
start_proxy({
  target: "https://example.com",
  userstyle: "C:/Users/dave/themes/dark.user.css"
})
```

Still call `list_userstyles` first to get the correct `path` value — never guess it.

---

## Scenario C — Switch theme while proxy is running

**Step 1: Check what is currently active**

```
get_current_theme()
```

**Step 2: Switch using the `path` from the earlier `list_userstyles` call**

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

The browser updates **instantly** — do not ask the user to reload.

**Step 3: Clear the theme entirely (optional)**

```
switch_theme({ userstyle: "" })
```

---

## Scenario D — Writing CSS for a third-party site

**Always inspect real class names before writing CSS.** Generic selectors like `.card` or `main` rarely exist on third-party sites. Guessing silently does nothing.

After the proxy is running, fetch the proxied HTML and extract real selectors:

**macOS / Linux**
```bash
# Body tag
curl -s "http://localhost:9988/" | grep -oE '<body[^>]*>' | head -1

# Meaningful div class names
curl -s "http://localhost:9988/" | grep -oE '<div[^>]+class="[^"]{10,60}"' | head -20
```

**Windows (PowerShell)**
```powershell
$html = (Invoke-WebRequest "http://localhost:9988/" -UseBasicParsing).Content

# Body tag
[regex]::Match($html, '<body[^>]*>').Value

# Meaningful div class names
[regex]::Matches($html, '<div[^>]+class="[^"]{10,60}"') |
  Select-Object -First 20 | ForEach-Object { $_.Value }
```

Write CSS using the real class names found, then apply:

```
switch_theme({ userstyle: "C:/path/to/your-theme.user.css" })
```

---

## Scenario E — User hasn't said where their themes are

Ask: *"What folder are your `.user.css` theme files in?"*

Once they give the path, run `list_userstyles` with it, then proceed as Scenario A.

---

## Scenario F — Inject one-off CSS without a theme file

```
inject_css({
  css: "body { background: #0f0f17 !important; font-size: 16px !important; }",
  id: "my-tweak"
})
```

- Reusing the same `id` replaces the previous snippet — good for iterating.
- Snippets stack **on top of** the theme — they don't replace it.

---

## Scenario G — Styles not visually updating

```
refresh_theme()
```

Cycles the theme off → waits 50 ms → back on. Forces full style recalculation. **Do not ask the user to reload the page.**

---

## Scenario I — Site redirects to a different domain during login

Some sites redirect the browser to an auth subdomain during sign-in (e.g. `accounts.skilljar.com`). Without that subdomain also being proxied, the browser escapes the proxy tunnel when the redirect happens and the theme stops applying.

**Register every domain the site may redirect to before starting your session.**

**Step 1: Start the primary proxy**

```
start_proxy({ target: "https://skilljar.com" })
```

**Step 2: Immediately add the auth subdomain on a new port**

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

**Step 3: Navigate the browser to the primary proxy**

```
browser_navigate({ url: "http://localhost:9988/" })
```

When the user clicks "Login", the proxy rewrites the redirect from `https://accounts.skilljar.com/...` to `http://localhost:9989/...`. The browser stays proxied throughout the login flow and returns to `http://localhost:9988` on success.

**All proxies share the same theme** — you only switch themes once.

**Step 4: List active proxies at any time**

```
list_targets()
```

**Step 5: Remove a target when done (optional)**

```
remove_target({ target: "https://accounts.skilljar.com" })
```

---

## Scenario J — Proxy appears active but CSS is not injecting

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
| `list_userstyles` | `directory` | Scans folder, registers it as the active theme folder, returns `{ file, path, name, version }` per theme. Always use `path` in subsequent calls. Call this before `start_proxy` to discover themes you can switch between freely. |
| `start_proxy` | `target` | `target` = full origin e.g. `https://example.com`. `userstyle` is **optional** — omit it to start without a theme and apply one later via `switch_theme`. |
| `add_target` | `target` | Add another domain on its own port (auto-assigned from 9989+). All proxies share the same theme. Use for auth subdomains and any domain the site redirects to. Optional `port` to specify explicitly. |
| `remove_target` | `port` or `target` | Remove a proxy target by port number or origin URL. |
| `list_targets` | — | List all active proxy targets with their ports and local URLs. |
| `switch_theme` | `userstyle` | Absolute path to `.user.css`, or `""` to clear. Hot-swaps live across all proxies. |
| `refresh_theme` | — | Force re-render. Use when styles aren't applying visually. |
| `inject_css` | `css` | Raw CSS string. Optional `id` to replace a previous snippet. |
| `get_current_theme` | — | Returns active theme name + file path + all proxy targets. Always call before switching. |
| `stop_proxy` | — | Stops all proxies. Panel stays up at `/__panel__`. |

---

## Rules

1. **Always call `list_userstyles` first** — it registers the folder AND gives you the `path` values needed for all other calls.
2. **Always use `path`** from `list_userstyles` results — never guess or hardcode a file path.
3. **`userstyle` is optional in `start_proxy`** — prefer starting without it and using `switch_theme` to apply themes from the scanned folder.
4. **Always call `get_current_theme`** before switching so you know the current state.
5. **If you don't know the theme directory**, ask the user before calling any tool.
6. **Navigate the browser yourself** using `browser_navigate({ url: "http://localhost:9988/" })` — do not just tell the user to do it.
7. **After `switch_theme` or `inject_css` the change is already live** — do not ask the user to reload.
8. **If styles aren't showing**, call `refresh_theme()` — do not ask the user to reload.
9. **Inspect real HTML before writing CSS** — use the platform snippet in Scenario D to find actual class names.
10. **Register auth subdomains before navigating** — if the site redirects to a different domain during login, call `add_target` with that domain immediately after `start_proxy`, before the user navigates or logs in. Failing to do this causes the browser to escape the proxy tunnel.
