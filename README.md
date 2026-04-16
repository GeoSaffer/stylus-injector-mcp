# Stylus Injector MCP

An MCP server that runs a local reverse proxy, injecting Stylus `.user.css` themes into HTML responses. Built for the **Cursor embedded browser** — design controls (element picker, CSS inspector, agent-aware change detection) stay fully functional while previewing themed pages.

Works with **any website**. The target origin is supplied at runtime, nothing is hardcoded.

## Quick start

```bash
git clone https://github.com/GeoSaffer/stylus-injector-mcp.git
cd stylus-injector-mcp
npm install
npm run setup
```

`npm run setup` auto-registers the server in `~/.cursor/mcp.json` with the correct absolute path.

> **Important:** After installing Git or Node.js, and after running `npm run setup`, **fully quit and relaunch Cursor** — not just "Reload MCP servers". Cursor inherits its PATH at launch time, so it won't see newly installed tools until it restarts.

## How it works

```
Cursor Browser  ──►  localhost:9988  ──►  https://any-site.com
                     (reverse proxy)
                     injects <style> into every HTML response
```

1. The agent (or you via the control panel) calls `start_proxy` with a target origin.
2. A local HTTP server starts on `:9988` and forwards all requests to the target.
3. Non-HTML responses (JS, images, fonts, API calls) pass through untouched.
4. HTML responses are intercepted — processed theme CSS is injected before `</head>`.
5. Navigate the Cursor embedded browser to `http://localhost:9988` to see the themed page.

## MCP tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `start_proxy` | `target` (required), `userstyle` (optional), `port` (optional, default `9988`) | Start the reverse proxy, optionally loading a `.user.css` theme |
| `switch_theme` | `userstyle` (required, `""` to clear) | Hot-swap the active theme without restarting the proxy |
| `inject_css` | `css` (required), `id` (optional) | Append ad-hoc CSS on top of the current theme |
| `list_userstyles` | `directory` (required) | Scan a directory for `.user.css` files and return metadata |
| `stop_proxy` | — | Shut down the proxy and free the port |

## Control panel

Once the proxy is running, open **`http://localhost:9988/__panel__`** for a visual control panel.

| Section | What it does |
|---------|-------------|
| **Status** | Live target origin, port, active theme name (auto-refreshes every 5s) |
| **Theme** | Scan any directory for `.user.css` files, click to apply, clear to remove |
| **CSS Editor** | Write and inject ad-hoc CSS (Ctrl+Enter to submit), assign snippet IDs |
| **Snippets** | View active snippets with previews, remove individually |
| **Stop** | Shut down the proxy from the panel |

The panel uses a REST API at `/__api__/*` on the same port. Every operation available via MCP tools is also available through the panel.

## Usage example

```
1. start_proxy({ target: "https://example.com", userstyle: "C:/themes/dark.user.css" })
   → Proxy started: http://localhost:9988 → https://example.com
     Control panel: http://localhost:9988/__panel__

2. Navigate Cursor browser to http://localhost:9988

3. switch_theme({ userstyle: "C:/themes/blue.user.css" })
   → Switched to theme: Blue Theme. Refresh the page.

4. inject_css({ css: "body { background: #0f0f17 !important; }", id: "debug" })
   → Injected snippet "debug". Refresh the page.

5. stop_proxy()
   → Proxy stopped. Port 9988 freed.
```

## Manual registration

If you prefer not to use `npm run setup`, merge this into `~/.cursor/mcp.json`:

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

Replace the path with wherever you cloned the repo.

## CSS parsing

The parser handles standard Stylus `.user.css` format:

- Strips `==UserStyle==` metadata blocks
- Unwraps `@-moz-document` wrappers
- Outputs raw CSS rules ready for injection

## Proxy behaviour

| Feature | Detail |
|---------|--------|
| **Header rewriting** | `Host`, `Referer`, `Origin` rewritten to match the target |
| **Redirect rewriting** | `Location` headers rewritten back to `localhost` |
| **Cookie rewriting** | `domain` and `secure` attributes stripped for localhost |
| **Security headers** | CSP, HSTS, X-Frame-Options removed for local dev |
| **Decompression** | gzip / brotli / deflate handled transparently |

## Project structure

```
index.js       MCP server + reverse proxy + API routes
panel.html     Visual control panel (served at /__panel__)
setup.js       Auto-registers in ~/.cursor/mcp.json
package.json   Dependencies: @modelcontextprotocol/sdk, zod
```

## Requirements

- **Git** — [download](https://git-scm.com) or install via command line:
  ```bash
  # Windows (winget)
  winget install Git.Git

  # Windows (choco)
  choco install git

  # macOS (Homebrew)
  brew install git

  # Linux (Debian/Ubuntu)
  sudo apt-get install -y git
  ```
  Restart your terminal after installing, then verify with `git --version`.

- **Node.js >= 18** — [download](https://nodejs.org) or install via command line:
  ```bash
  # Windows (winget)
  winget install OpenJS.NodeJS.LTS

  # Windows (choco)
  choco install nodejs-lts

  # macOS (Homebrew)
  brew install node

  # Linux (Debian/Ubuntu)
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
  Restart your terminal after installing, then verify with `node -v && npm -v`.

- **Cursor IDE** with embedded browser

## License

Proprietary — All rights reserved. See [LICENSE](LICENSE) for details.
