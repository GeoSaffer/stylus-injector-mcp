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

## Live CSS hot-swap

Every proxied HTML page receives an injected `<script>` that opens a Server-Sent Events connection back to the proxy (`/__api__/events`). When a theme or snippet changes, the server broadcasts the new CSS over that connection and the browser updates the `<style>` tags in place — **no page reload needed**, scroll position and page state are preserved.

Triggers: `switch_theme`, `inject_css`, panel theme picker, panel CSS editor, snippet removal.

## How it works

```
Cursor Browser  ──►  localhost:9988  ──►  https://any-site.com
                     localhost:9989  ──►  https://accounts.any-site.com  (optional extra target)
                     (reverse proxies)
                     inject <style> into every HTML response
                     cross-domain URL rewriting keeps login redirects proxied
```

1. The agent (or you via the control panel) calls `start_proxy` with a target origin.
2. A local HTTP server starts on `:9988` and forwards all requests to the target.
3. Call `add_target` to register additional domains (e.g. auth subdomains) on ports 9989, 9990, etc.
4. Non-HTML responses (JS, images, fonts, API calls) pass through untouched.
5. HTML responses are intercepted — theme CSS is injected before `</head>`.
6. All `Location` headers and body URLs are rewritten across every registered target so the browser stays proxied through login flows.
7. Navigate the Cursor embedded browser to `http://localhost:9988` to see the themed page.

## MCP tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_userstyles` | `directory` (required) | Scan a folder for `.user.css` files, register it as the active theme folder, and return metadata. Always call this first — use the returned `path` values in all other calls. |
| `start_proxy` | `target` (required), `userstyle` (optional) | Start the primary reverse proxy. `userstyle` is optional — omit it to start without a theme and apply one later via `switch_theme`. |
| `add_target` | `target` (required), `port` (optional) | Add another domain on its own port (auto-assigned from 9989). All targets share the same theme. Use for auth subdomains or any domain the site redirects to. |
| `remove_target` | `port` or `target` | Remove a proxy target by port number or origin URL. |
| `list_targets` | — | List all active proxy targets with their ports and local URLs. |
| `switch_theme` | `userstyle` (required, `""` to clear) | Hot-swap to any theme using its `path` from `list_userstyles` — updates live across all proxies, no page reload |
| `inject_css` | `css` (required), `id` (optional) | Append ad-hoc CSS on top of the current theme |
| `refresh_theme` | — | Cycle the active theme off then on to force a full CSS re-render |
| `get_current_theme` | — | Return the active theme name, file path, and all proxy targets |
| `stop_proxy` | — | Shut down all proxies and free their ports |

## Control panel

The control panel is **always available** at `http://localhost:9988/__panel__` the moment Cursor connects to the MCP server — no need to call `start_proxy` first.

| Section | What it does |
|---------|-------------|
| **Start Proxy** | Enter a target URL (and optional theme path) and click Start — shown when proxy is idle |
| **Status** | Live list of all active proxy targets with ports, “Open ↗” links, and per-target Remove buttons (auto-refreshes every 5s) |
| **Add Target** | Add additional domains (e.g. auth subdomains) on new ports — shown when proxy is running |
| **Theme** | Scan any directory for `.user.css` files, click to apply, clear to remove |
| **CSS Editor** | Write and inject ad-hoc CSS (Ctrl+Enter to submit), assign snippet IDs |
| **Snippets** | View active snippets with previews, remove individually |
| **Stop All** | Stop all proxies — panel stays available |

The panel uses a REST API at `/__api__/*` on the same port. Every operation available via MCP tools is also available through the panel.

> **Custom port:** set `STYLUS_PORT` in your mcp.json entry to use a port other than `9988`:
> ```json
> {
>   "stylus-injector": {
>     "command": "node",
>     "args": ["/path/to/index.js"],
>     "env": { "STYLUS_PORT": "9000" }
>   }
> }
> ```

## Usage example

```
1. list_userstyles({ directory: "C:/themes" })
   → Registers the folder and returns all available themes with full paths.
     Always use the returned "path" field in subsequent calls — never guess paths.
     [ { "file": "dark.user.css", "path": "C:/themes/dark.user.css", "name": "Dark Theme" }, ... ]

2. start_proxy({ target: "https://example.com" })
   → Proxy active: http://localhost:9988 → https://example.com

3. add_target({ target: "https://accounts.example.com" })
   → Target added: http://localhost:9989 → https://accounts.example.com
     Register auth subdomains BEFORE navigating so login redirects stay proxied.

4. browser_navigate({ url: "http://localhost:9988/" })
   → Page loads through proxy. Login redirects to accounts.example.com are
     automatically rewritten to http://localhost:9989/ — stays proxied.

5. switch_theme({ userstyle: "C:/themes/dark.user.css" })
   → Dark Theme applied live across all proxies — no page reload needed

6. switch_theme({ userstyle: "C:/themes/blue.user.css" })
   → Switch to any other theme in the folder at any time — live, no reload

7. Inspect real HTML class names before writing CSS (third-party sites only)
   → macOS / Linux:
     curl -s "http://localhost:9988/" | grep -oE '<div[^>]+class="[^"]{10,60}"' | head -20

   → Windows (PowerShell):
     $html = (Invoke-WebRequest "http://localhost:9988/" -UseBasicParsing).Content
     [regex]::Matches($html, '<div[^>]+class="[^"]{10,60}"') |
       Select-Object -First 20 | ForEach-Object { $_.Value }

8. inject_css({ css: "body { background: #0f0f17 !important; }", id: "debug" })
   → Injected snippet "debug".  (applies live — no page reload)

9. refresh_theme()
   → Cycles theme off then on to force a full CSS re-render

10. stop_proxy()
    → All proxies stopped. Ports 9988, 9989 freed.
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

## `.user.css` format

Every theme file must begin with a `==UserStyle==` metadata block:

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

The parser automatically:
- Strips the `==UserStyle==` metadata block
- Unwraps `@-moz-document` wrappers
- Outputs raw CSS rules ready for injection

## Proxy behaviour

| Feature | Detail |
|---------|--------|
| **Header rewriting** | `Host`, `Referer`, `Origin` rewritten to match the target |
| **Redirect rewriting** | `Location` headers rewritten back to `localhost` — across all registered targets |
| **Cross-domain URL rewriting** | All body URLs (HTML + CSS) rewritten across every registered target — links between main site and auth subdomain stay proxied |
| **Cookie rewriting** | `domain` and `secure` attributes stripped for localhost |
| **Security headers** | CSP, HSTS, X-Frame-Options removed for local dev |
| **Decompression** | gzip / brotli / deflate handled transparently |

## Cursor Agent Skill

A Cursor Agent Skill is bundled at `.cursor/skills/stylus-injector-mcp/SKILL.md`. It teaches agents the full tool set, typical workflow, and key behaviours so they can operate this MCP without manual guidance.

To make the skill available across **all your projects** (not just this repo), copy it to your personal skills folder:

```bash
# macOS / Linux
cp -r .cursor/skills/stylus-injector-mcp ~/.cursor/skills/

# Windows (PowerShell)
Copy-Item -Recurse .cursor\skills\stylus-injector-mcp ~\.cursor\skills\
```

Once in `~/.cursor/skills/`, Cursor will automatically apply the skill whenever you mention themes, proxying a site, `.user.css` files, or the stylus injector in any project.

## Project structure

```
index.js       MCP server + reverse proxy + API routes
panel.html     Visual control panel (served at /__panel__)
setup.js       Auto-registers in ~/.cursor/mcp.json
package.json   Dependencies: @modelcontextprotocol/sdk, zod
.cursor/
  skills/
    stylus-injector-mcp/
      SKILL.md   Cursor Agent Skill for this MCP
```

## Troubleshooting

### Proxy appears active but CSS is not injecting

A stale Node.js process from a previous session may be holding port `9988`. Check:

```powershell
netstat -ano | findstr ":9988"
```

The PID shown should match the current Cursor MCP process. If it belongs to an old process, kill it then reload MCP servers in Cursor: **Settings → MCP → Reload** on `stylus-injector`.

### Styles applied but not rendering visually

Call `refresh_theme()` — this cycles the theme off then back on, forcing a full browser style recalculation. Do not ask the user to reload the page.

### CSS selectors not matching

Inspect the actual HTML served by the proxy before writing selectors. Generic names like `.card` or `main` rarely exist on third-party sites:

```bash
# macOS / Linux
curl -s "http://localhost:9988/" | grep -oE '<div[^>]+class="[^"]{10,60}"' | head -20
```

```powershell
# Windows (PowerShell)
$html = (Invoke-WebRequest "http://localhost:9988/" -UseBasicParsing).Content
[regex]::Matches($html, '<div[^>]+class="[^"]{10,60}"') |
  Select-Object -First 20 | ForEach-Object { $_.Value }
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
