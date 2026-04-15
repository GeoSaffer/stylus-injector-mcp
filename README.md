# Stylus Injector MCP

An MCP server that runs a local reverse proxy, injecting processed Stylus `.user.css` themes into HTML responses. Built for the **Cursor embedded browser** so that design controls (element picker, CSS inspector, agent-aware change detection) remain fully functional while previewing themed pages.

Works with **any website** — the target origin is supplied at runtime, not hardcoded.

## Quick start

```bash
git clone <repo-url> stylus-injector-mcp
cd stylus-injector-mcp
npm install
npm run setup      # auto-registers in Cursor's ~/.cursor/mcp.json
```

Restart Cursor (or reload MCP servers) after setup.

## How it works

```
Cursor Browser  →  localhost:9988  →  https://any-target-site.com
                   (reverse proxy)
                   injects <style> into HTML responses
```

1. `start_proxy` launches a local HTTP server (default `:9988`) forwarding to any origin you specify.
2. Non-HTML responses (JS, images, fonts, API calls) pass through untouched.
3. HTML responses are intercepted — the proxy injects `<style>` tags containing the processed theme CSS before `</head>`.
4. Navigate the Cursor embedded browser to `http://localhost:9988` to see the themed page with full design controls.

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `start_proxy` | `target` (required), `userstyle` (optional), `port` (optional, default 9988) | Start the reverse proxy, optionally loading a `.user.css` theme |
| `switch_theme` | `userstyle` (required, `""` to clear) | Hot-swap the active theme without restarting |
| `inject_css` | `css` (required), `id` (optional) | Append ad-hoc CSS on top of the current theme |
| `list_userstyles` | `directory` (required) | Scan a directory for `.user.css` files and return metadata |
| `stop_proxy` | — | Shut down the proxy and free the port |

## Manual registration

If you prefer not to use `npm run setup`, add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stylus-injector": {
      "command": "node",
      "args": ["/full/path/to/stylus-injector-mcp/index.js"]
    }
  }
}
```

Replace `/full/path/to/` with wherever you cloned the repo.

## Usage example

```
1. start_proxy({ target: "https://example.com", userstyle: "/path/to/theme.user.css" })
   → Proxy started: http://localhost:9988 → https://example.com

2. Navigate Cursor browser to http://localhost:9988

3. switch_theme({ userstyle: "/path/to/other-theme.user.css" })
   → Switched to theme: Other Theme. Refresh the page.

4. inject_css({ css: "body { background: red !important; }", id: "debug" })
   → Injected snippet "debug". Refresh the page.

5. stop_proxy()
   → Proxy stopped. Port 9988 freed.
```

## Control panel

Once the proxy is running, open `http://localhost:9988/__panel__` for a visual control panel.

The panel provides:
- **Live status** — target origin, port, active theme (auto-refreshes every 5 seconds)
- **Theme switcher** — scan any directory for `.user.css` files, click to apply, clear to remove
- **CSS editor** — write and inject ad-hoc CSS with Ctrl+Enter, assign snippet IDs for later replacement
- **Snippet manager** — view all active snippets with previews, remove individually

The panel communicates with the proxy via a REST API at `/__api__/*` (same port, no CORS issues). All operations from the MCP tools are also available through the panel.

## CSS parsing

The parser handles standard Stylus `.user.css` format:
- Strips `==UserStyle==` metadata blocks
- Unwraps `@-moz-document` wrappers
- Outputs raw CSS rules ready for injection

## Proxy behaviour

- **Header rewriting** — `Host`, `Referer`, `Origin` rewritten for target compatibility
- **Redirect rewriting** — `Location` headers rewritten back to `localhost`
- **Cookie rewriting** — `domain` and `secure` attributes stripped so cookies work on localhost
- **Security headers** — CSP, HSTS, X-Frame-Options removed for local dev
- **Decompression** — gzip/brotli/deflate handled transparently

## Requirements

- Node.js >= 18
- Cursor IDE with embedded browser

## License

Proprietary — All rights reserved. See [LICENSE](LICENSE) for details.
