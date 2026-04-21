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

A local HTTP reverse proxy on `localhost:9988` that injects `.user.css` themes into every HTML response. Theme and snippet changes are broadcast via SSE and hot-swapped in the browser — no page reload required.

## MCP tools

| Tool | Key params | Purpose |
|---|---|---|
| `list_userstyles` | `directory` | Scan a folder for `.user.css` files — always run this first to discover available themes |
| `start_proxy` | `target`, `userstyle?` | Start the proxy. `target` is the full origin (e.g. `https://example.com`). Optionally load a theme at start |
| `switch_theme` | `userstyle` | Hot-swap theme live. Pass `""` to clear |
| `refresh_theme` | — | Cycle the theme off then on to force a full CSS re-render (use when styles aren't visually applying) |
| `inject_css` | `css`, `id?` | Inject ad-hoc CSS on top of the current theme. Reuse the same `id` to replace a previous snippet |
| `get_current_theme` | — | Return active theme name, file path, and proxy target — call this before making changes |
| `stop_proxy` | — | Stop the proxy (panel stays available) |

## Typical workflow

```
1. list_userstyles({ directory: "C:/path/to/themes" })
   → See what .user.css files are available

2. start_proxy({ target: "https://example.com", userstyle: "C:/path/to/dark.user.css" })
   → Proxy active: http://localhost:9988 → https://example.com

3. Tell the user to navigate the Cursor browser to http://localhost:9988

4. switch_theme({ userstyle: "C:/path/to/other.user.css" })
   → Theme updates live in the browser

5. inject_css({ css: "body { font-size: 16px !important; }", id: "font-fix" })
   → CSS applied live on top of the theme

6. refresh_theme()
   → Use if a style change isn't visually rendering

7. stop_proxy()
   → Proxy stopped, port freed
```

## Key behaviours

- **Live hot-swap** — every proxied HTML page has an SSE listener injected. `switch_theme`, `refresh_theme`, and `inject_css` all push CSS updates instantly without a page reload.
- **Panel** — always available at `http://localhost:9988/__panel__` even before `start_proxy` is called. The panel persists the last used scan directory and theme list.
- **Port** — default `9988`. Override with `STYLUS_PORT` env var in `mcp.json`.
- **CSS parsing** — strips `==UserStyle==` metadata blocks and `@-moz-document` wrappers from `.user.css` files automatically.

## Before switching themes

Always call `get_current_theme` first so you know what is active and can reference it in your response.

## Injecting CSS snippets

```
inject_css({ css: "nav { display: none !important; }", id: "hide-nav" })
```

Calling `inject_css` with the same `id` replaces the previous snippet. Snippets stack on top of the theme — they don't replace it.
