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
    { "file": "dark.user.css",  "path": "C:/Users/dave/themes/dark.user.css",  "name": "Dark Theme", "version": "1.2" },
    { "file": "blue.user.css",  "path": "C:/Users/dave/themes/blue.user.css",  "name": "Blue Slate", "version": "1.0" }
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

Response: `Proxy active: http://localhost:9988 → https://example.com  Theme: Dark Theme`

**Step 3: Tell the user to open the browser**

Say: *"Navigate the Cursor embedded browser to `http://localhost:9988`"*

---

## Scenario B — Switch theme while proxy is running

**Step 1: Check what is currently active**

```
get_current_theme()
```

Response: `Active theme: Dark Theme  File: C:/Users/dave/themes/dark.user.css  Proxy target: https://example.com`

**Step 2: Switch to a different theme**

Use the `path` from the `list_userstyles` result:

```
switch_theme({ userstyle: "C:/Users/dave/themes/blue.user.css" })
```

Response: `Switched to theme: Blue Slate.`

The browser updates **instantly** — no page reload. Tell the user to look at the browser now.

**Step 3: Clear the theme entirely (optional)**

```
switch_theme({ userstyle: "" })
```

---

## Scenario C — User hasn't said where their themes are

Ask: *"What folder are your `.user.css` theme files in?"*

Once they give the path, run `list_userstyles` with it, then proceed as Scenario A.

---

## Scenario D — Inject one-off CSS without a theme file

```
inject_css({
  css: "body { background: #0f0f17 !important; font-size: 16px !important; }",
  id: "my-tweak"
})
```

- The `id` is optional but reusing it replaces the previous snippet (good for iterating).
- Snippets stack **on top of** the theme — they don't replace it.
- Call again with the same `id` and new CSS to update it live.

---

## Scenario E — Styles not visually updating

```
refresh_theme()
```

This cycles the theme off → waits 50 ms → back on. Forces the browser to fully recalculate styles.

---

## Tool reference

| Tool | Required params | Notes |
|---|---|---|
| `list_userstyles` | `directory` | Returns array of `{ file, path, name, version }`. Use `path` in all other calls. |
| `start_proxy` | `target` | `target` = full origin e.g. `https://example.com`. `userstyle` = absolute path from `list_userstyles`. |
| `switch_theme` | `userstyle` | Absolute path to `.user.css`, or `""` to clear. Hot-swaps live. |
| `refresh_theme` | — | Force re-render. Use when styles aren't applying visually. |
| `inject_css` | `css` | Raw CSS string. Optional `id` to replace a previous snippet. |
| `get_current_theme` | — | Returns active theme name + file path + proxy target. Always call this before switching. |
| `stop_proxy` | — | Stops proxy. Panel stays up at `/__panel__`. |

---

## Rules

1. **Always use `path`** from `list_userstyles` results — never guess a file path.
2. **Always call `get_current_theme`** before switching so you know the current state.
3. **If you don't know the theme directory**, ask the user before calling any tool.
4. **After `switch_theme` or `inject_css`**, tell the user the change is already live — they do not need to reload.
5. **If styles aren't showing**, call `refresh_theme()` — do not ask the user to reload.
