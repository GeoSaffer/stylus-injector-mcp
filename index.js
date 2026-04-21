#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelHTML = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");

// ---------------------------------------------------------------------------
// Config — override port via STYLUS_PORT env var in mcp.json
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.STYLUS_PORT || "9988", 10);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// targets: Map<port, { origin: string|null, hostPattern: RegExp|null, server: http.Server|null }>
// The primary server on PORT is always in this map (origin may be null = panel-only mode).
// Additional servers (PORT+1, PORT+2, …) are added on demand via add_target.
const targets = new Map();
const blockedPorts = new Set(); // ports occupied externally (EADDRINUSE on bind attempt)

let themeCSS = "";
let themeName = "";
let themeFile = "";
const adhocSnippets = new Map();
let snippetCounter = 0;
const sseClients = new Set();
let lastScanDir = "";
let lastScanFiles = [];

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function buildHostPattern(origin) {
  return new RegExp(
    `https?://${new URL(origin).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "gi"
  );
}

function setTargetForPort(port, origin) {
  const entry = targets.get(port);
  if (!entry) return;
  entry.origin = origin || null;
  entry.hostPattern = origin ? buildHostPattern(origin) : null;
}

function getActiveTargets() {
  return [...targets.entries()]
    .filter(([, e]) => e.origin)
    .map(([port, e]) => ({ port, origin: e.origin, url: `http://localhost:${port}` }));
}

function nextAvailablePort(startFrom = PORT + 1) {
  let p = startFrom;
  while (targets.has(p) || blockedPorts.has(p)) p++;
  return p;
}

function resetState() {
  themeCSS = "";
  themeName = "";
  themeFile = "";
  adhocSnippets.clear();
  snippetCounter = 0;
}

function broadcast(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ---------------------------------------------------------------------------
// CSS parser  -- strips Stylus metadata, unwraps @-moz-document
// ---------------------------------------------------------------------------

function extractCSS(raw) {
  let css = raw.replace(/\/\*\s*==UserStyle==[\s\S]*?==\/UserStyle==\s*\*\//, "");
  css = css.replace(/@-moz-document\s+[^{]+\{/, "");
  const lastBrace = css.lastIndexOf("}");
  if (lastBrace !== -1) css = css.slice(0, lastBrace) + css.slice(lastBrace + 1);
  return css.trim();
}

function parseMetadata(raw) {
  const meta = {};
  const block = raw.match(/\/\*\s*==UserStyle==([\s\S]*?)==\/UserStyle==\s*\*\//);
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const m = line.match(/@(\w+)\s+(.*)/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return meta;
}

// ---------------------------------------------------------------------------
// HTML injection block
// ---------------------------------------------------------------------------

function injectionBlock() {
  // Use a relative URL so the SSE connection works from any proxy port
  const liveScript = `<script id="stylus-injector-live">(function(){
  if (window.__siLive) return;
  window.__siLive = true;
  var es = new EventSource('/__api__/events');
  es.addEventListener('theme-changed', function(e) {
    var el = document.getElementById('stylus-injector-theme');
    if (!el) { el = document.createElement('style'); el.id = 'stylus-injector-theme'; document.head.appendChild(el); }
    el.textContent = JSON.parse(e.data);
  });
  es.addEventListener('theme-cleared', function() {
    var el = document.getElementById('stylus-injector-theme');
    if (el) el.remove();
  });
  es.addEventListener('snippets-updated', function(e) {
    var el = document.getElementById('stylus-injector-adhoc');
    if (!el) { el = document.createElement('style'); el.id = 'stylus-injector-adhoc'; document.head.appendChild(el); }
    el.textContent = JSON.parse(e.data);
  });
  es.addEventListener('snippets-cleared', function() {
    var el = document.getElementById('stylus-injector-adhoc');
    if (el) el.remove();
  });
})();<\/script>`;

  const parts = ["\n<!-- Injected by stylus-injector MCP -->", liveScript];
  if (themeCSS) {
    parts.push(`<style id="stylus-injector-theme">\n${themeCSS}\n</style>`);
  }
  if (adhocSnippets.size > 0) {
    parts.push(
      `<style id="stylus-injector-adhoc">\n${[...adhocSnippets.values()].join("\n")}\n</style>`
    );
  }
  return parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

function decompress(stream, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip":    return stream.pipe(zlib.createGunzip());
    case "br":      return stream.pipe(zlib.createBrotliDecompress());
    case "deflate": return stream.pipe(zlib.createInflate());
    default:        return stream;
  }
}

// ---------------------------------------------------------------------------
// Theme loader
// ---------------------------------------------------------------------------

async function loadTheme(filepath) {
  const abs = path.resolve(filepath);
  const raw = await fs.promises.readFile(abs, "utf8");
  const meta = parseMetadata(raw);
  themeCSS = extractCSS(raw);
  themeName = meta.name || path.basename(filepath);
  themeFile = abs;
  return { name: themeName, meta };
}

// ---------------------------------------------------------------------------
// URL rewriters — rewrite across ALL registered targets (cross-domain support)
// ---------------------------------------------------------------------------

function rewriteAllTargetUrls(body) {
  for (const [port, entry] of targets) {
    if (entry.origin && entry.hostPattern) {
      body = body.replace(entry.hostPattern, `http://localhost:${port}`);
    }
  }
  return body;
}

function rewriteLocationHeader(location) {
  for (const [port, entry] of targets) {
    if (entry.origin && entry.hostPattern) {
      const rewritten = location.replace(entry.hostPattern, `http://localhost:${port}`);
      if (rewritten !== location) return rewritten;
    }
  }
  return location;
}

// ---------------------------------------------------------------------------
// Proxy request handler
// ---------------------------------------------------------------------------

function proxyRequest(req, res, entry, port) {
  const { origin } = entry;
  const url = new URL(origin);
  const secure = url.protocol === "https:";
  const doRequest = secure ? https.request : http.request;

  const headers = { ...req.headers, host: url.host };
  if (headers.referer) {
    headers.referer = headers.referer.replace(`http://localhost:${port}`, url.origin);
  }
  if (headers.origin && headers.origin.includes(`localhost:${port}`)) {
    headers.origin = url.origin;
  }
  delete headers["accept-encoding"];

  const opts = {
    hostname: url.hostname,
    port: url.port || (secure ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
  };

  const proxyReq = doRequest(opts, (proxyRes) => {
    const ct = proxyRes.headers["content-type"] || "";

    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocationHeader(proxyRes.headers.location);
    }

    delete proxyRes.headers["content-security-policy"];
    delete proxyRes.headers["content-security-policy-report-only"];
    delete proxyRes.headers["strict-transport-security"];
    delete proxyRes.headers["x-frame-options"];

    if (proxyRes.headers["set-cookie"]) {
      const cookies = Array.isArray(proxyRes.headers["set-cookie"])
        ? proxyRes.headers["set-cookie"]
        : [proxyRes.headers["set-cookie"]];
      proxyRes.headers["set-cookie"] = cookies.map((c) =>
        c.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, "")
      );
    }

    if (ct.includes("text/html") || ct.includes("text/css")) {
      const decoded = decompress(proxyRes, proxyRes.headers["content-encoding"]);
      const chunks = [];
      decoded.on("data", (c) => chunks.push(c));
      decoded.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");

        if (ct.includes("text/html")) {
          const tag = injectionBlock();
          if (/<\/head>/i.test(body)) body = body.replace(/<\/head>/i, tag + "</head>");
          else if (/<\/body>/i.test(body)) body = body.replace(/<\/body>/i, tag + "</body>");
          else body += tag;
        }

        // Rewrite URLs across ALL registered targets — keeps login redirects proxied
        body = rewriteAllTargetUrls(body);

        const hdrs = { ...proxyRes.headers };
        delete hdrs["content-encoding"];
        delete hdrs["content-length"];
        delete hdrs["transfer-encoding"];
        hdrs["content-length"] = Buffer.byteLength(body);
        res.writeHead(proxyRes.statusCode, hdrs);
        res.end(body);
      });
      decoded.on("error", (e) => {
        res.writeHead(502);
        res.end(`Proxy error: ${e.message}`);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(`Proxy error: ${e.message}`);
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// API handler  (served at /__api__/*)
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleAPI(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const route = reqUrl.pathname.replace("/__api__", "");

  try {
    // GET /status
    if (req.method === "GET" && route === "/status") {
      return jsonResponse(res, 200, {
        targets: getActiveTargets(),
        port: PORT,
        theme: { name: themeName || "", file: themeFile || "" },
        snippets: [...adhocSnippets.entries()].map(([id, css]) => ({
          id,
          preview: css.slice(0, 120),
          length: css.length,
        })),
        scanDir: lastScanDir,
        scanFiles: lastScanFiles,
      });
    }

    // GET /events — SSE stream for live CSS hot-swap
    if (req.method === "GET" && route === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // POST /start-proxy
    if (req.method === "POST" && route === "/start-proxy") {
      const { target, userstyle } = await readBody(req);
      if (!target) return jsonResponse(res, 400, { error: "Missing target URL" });
      setTargetForPort(PORT, target);
      resetState();
      let theme = "";
      if (userstyle) {
        const { name } = await loadTheme(userstyle);
        theme = name;
      }
      return jsonResponse(res, 200, { targets: getActiveTargets(), theme, port: PORT });
    }

    // POST /add-target
    if (req.method === "POST" && route === "/add-target") {
      const body = await readBody(req);
      if (!body.target) return jsonResponse(res, 400, { error: "Missing target URL" });
      try {
        const assignedPort = await addTargetOrigin(body.target, body.port);
        return jsonResponse(res, 200, {
          port: assignedPort,
          target: body.target,
          url: `http://localhost:${assignedPort}`,
          targets: getActiveTargets(),
        });
      } catch (e) {
        return jsonResponse(res, 500, { error: e.message });
      }
    }

    // POST /remove-target
    if (req.method === "POST" && route === "/remove-target") {
      const body = await readBody(req);
      let targetPort = body.port;
      if (!targetPort && body.target) {
        for (const [p, e] of targets) {
          if (e.origin === body.target) { targetPort = p; break; }
        }
      }
      if (!targetPort) return jsonResponse(res, 400, { error: "Specify port or target URL" });
      try {
        await removeTargetPort(targetPort);
        return jsonResponse(res, 200, {
          message: `Target on port ${targetPort} removed`,
          targets: getActiveTargets(),
        });
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    // GET /list-targets
    if (req.method === "GET" && route === "/list-targets") {
      return jsonResponse(res, 200, { targets: getActiveTargets() });
    }

    // GET /list-userstyles
    if (req.method === "GET" && route === "/list-userstyles") {
      const directory = reqUrl.searchParams.get("directory");
      if (!directory) return jsonResponse(res, 400, { error: "Missing directory parameter" });
      const dir = path.resolve(directory);
      let entries;
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        return jsonResponse(res, 400, { error: `Cannot read directory: ${dir}` });
      }
      const cssFiles = entries.filter((f) => f.endsWith(".user.css"));
      const files = [];
      for (const file of cssFiles) {
        try {
          const raw = await fs.promises.readFile(path.join(dir, file), "utf8");
          const meta = parseMetadata(raw);
          files.push({
            file,
            path: path.join(dir, file),
            name: meta.name || file,
            version: meta.version || "",
            description: meta.description || "",
          });
        } catch {
          files.push({ file, error: "Could not read file" });
        }
      }
      lastScanDir = dir;
      lastScanFiles = files;
      return jsonResponse(res, 200, { files });
    }

    // POST /switch-theme
    if (req.method === "POST" && route === "/switch-theme") {
      const { userstyle } = await readBody(req);
      if (userstyle === undefined) return jsonResponse(res, 400, { error: "Missing userstyle field" });
      if (!userstyle) {
        themeCSS = ""; themeName = ""; themeFile = "";
        broadcast("theme-cleared", null);
        return jsonResponse(res, 200, { name: "", message: "Theme cleared" });
      }
      const { name } = await loadTheme(userstyle);
      broadcast("theme-changed", themeCSS);
      return jsonResponse(res, 200, { name, message: `Switched to ${name}` });
    }

    // POST /inject-css
    if (req.method === "POST" && route === "/inject-css") {
      const { css, id } = await readBody(req);
      if (!css) return jsonResponse(res, 400, { error: "Missing css field" });
      const sid = id || `adhoc-${++snippetCounter}`;
      adhocSnippets.set(sid, css);
      broadcast("snippets-updated", [...adhocSnippets.values()].join("\n"));
      return jsonResponse(res, 200, { id: sid, count: adhocSnippets.size });
    }

    // POST /remove-snippet
    if (req.method === "POST" && route === "/remove-snippet") {
      const { id } = await readBody(req);
      if (!id) return jsonResponse(res, 400, { error: "Missing id field" });
      adhocSnippets.delete(id);
      if (adhocSnippets.size > 0) {
        broadcast("snippets-updated", [...adhocSnippets.values()].join("\n"));
      } else {
        broadcast("snippets-cleared", null);
      }
      return jsonResponse(res, 200, { removed: id, count: adhocSnippets.size });
    }

    // POST /clear-snippets
    if (req.method === "POST" && route === "/clear-snippets") {
      adhocSnippets.clear();
      broadcast("snippets-cleared", null);
      return jsonResponse(res, 200, { message: "All snippets cleared" });
    }

    // POST /refresh-theme
    if (req.method === "POST" && route === "/refresh-theme") {
      if (!themeCSS) {
        return jsonResponse(res, 200, { message: "No theme active, nothing to refresh" });
      }
      const savedCSS = themeCSS;
      broadcast("theme-cleared", null);
      await new Promise(r => setTimeout(r, 50));
      broadcast("theme-changed", savedCSS);
      return jsonResponse(res, 200, { message: "Theme refreshed" });
    }

    // POST /stop
    if (req.method === "POST" && route === "/stop") {
      await stopAllTargets();
      resetState();
      return jsonResponse(res, 200, { message: "All proxies stopped. Panel still available." });
    }

    jsonResponse(res, 404, { error: "Unknown API route" });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

function createProxyServer(port) {
  targets.set(port, { origin: null, hostPattern: null, server: null });

  const server = http.createServer((req, res) => {
    const entry = targets.get(port);

    if (req.url === "/__panel__" || req.url === "/__panel__/") {
      const buf = Buffer.from(panelHTML, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
      });
      res.end(buf);
      return;
    }

    if (req.url.startsWith("/__api__/")) {
      handleAPI(req, res).catch((e) => jsonResponse(res, 500, { error: e.message }));
      return;
    }

    if (!entry || !entry.origin) {
      res.writeHead(302, { Location: "/__panel__" });
      res.end();
      return;
    }

    proxyRequest(req, res, entry, port);
  });

  targets.get(port).server = server;
  return server;
}

async function addTargetOrigin(origin, portArg) {
  const maxAttempts = portArg ? 1 : 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = portArg || nextAvailablePort(PORT + 1);

    if (!targets.has(port)) {
      const server = createProxyServer(port);
      try {
        await new Promise((resolve, reject) => {
          server.once("error", (e) => {
            targets.delete(port);
            reject(e);
          });
          server.listen(port, () => {
            server.on("error", (e) => {
              process.stderr.write(`[stylus-injector] Server error (port ${port}): ${e.message}\n`);
            });
            resolve();
          });
        });
      } catch (e) {
        if (e.code === "EADDRINUSE" && !portArg) {
          // Port occupied externally — remember it so nextAvailablePort skips it
          blockedPorts.add(port);
          process.stderr.write(`[stylus-injector] Port ${port} busy externally, trying next…\n`);
          continue;
        }
        throw e;
      }
    }

    setTargetForPort(port, origin);
    process.stderr.write(`[stylus-injector] Target added: http://localhost:${port} → ${origin}\n`);
    return port;
  }

  throw new Error(`No available port found after ${maxAttempts} attempts (starting from ${PORT + 1})`);
}

async function removeTargetPort(port) {
  if (!targets.has(port)) throw new Error(`No proxy on port ${port}`);
  const entry = targets.get(port);
  if (port === PORT) {
    // Primary server — clear its target but keep the server running
    setTargetForPort(PORT, null);
  } else {
    await new Promise((resolve) => entry.server.close(resolve));
    targets.delete(port);
  }
  process.stderr.write(`[stylus-injector] Target removed on port ${port}\n`);
}

async function stopAllTargets() {
  const ports = [...targets.keys()];
  for (const port of ports) {
    if (port === PORT) {
      setTargetForPort(PORT, null);
    } else {
      const entry = targets.get(port);
      if (entry && entry.server) {
        await new Promise((resolve) => entry.server.close(resolve));
        targets.delete(port);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Start primary server — panel always available at http://localhost:PORT/__panel__
// ---------------------------------------------------------------------------

const primaryServer = createProxyServer(PORT);

primaryServer.listen(PORT, () => {
  process.stderr.write(
    `[stylus-injector] Panel ready: http://localhost:${PORT}/__panel__\n`
  );
});

primaryServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write(
      `[stylus-injector] Port ${PORT} is already in use. Set STYLUS_PORT env var in mcp.json to use a different port.\n`
    );
  } else {
    process.stderr.write(`[stylus-injector] Server error: ${e.message}\n`);
  }
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: "stylus-injector",
  version: "1.0.0",
});

// ----- start_proxy --------------------------------------------------------

mcp.tool(
  "start_proxy",
  "Activate the reverse proxy for the primary domain — sets the main target site and optionally loads a theme. The panel is always available at /__panel__ regardless. Use add_target afterwards to register additional domains (e.g. auth subdomains) so login redirects stay proxied.",
  {
    target: z.string().describe("Origin to proxy, e.g. https://example.com"),
    userstyle: z
      .string()
      .optional()
      .describe("Absolute or relative path to a .user.css file to inject"),
  },
  async ({ target, userstyle }) => {
    setTargetForPort(PORT, target);
    resetState();

    let themeInfo = "";
    if (userstyle) {
      try {
        const { name } = await loadTheme(userstyle);
        themeInfo = `\nTheme: ${name}`;
      } catch (e) {
        return { content: [{ type: "text", text: `Error loading theme: ${e.message}` }] };
      }
    }

    const localUrl = `http://localhost:${PORT}`;
    return {
      content: [{
        type: "text",
        text: `Proxy active: ${localUrl} → ${target}${themeInfo}\n\nEmbedded browser: ${localUrl}\nControl panel:    ${localUrl}/__panel__\n\nTip: use add_target to register additional domains (e.g. https://accounts.example.com) before navigating so login redirects stay proxied.`,
      }],
    };
  }
);

// ----- add_target ---------------------------------------------------------

mcp.tool(
  "add_target",
  "Add an additional domain to the proxy on a new port. All targets share the same active theme and SSE channel. Use this to keep login redirects proxied — register every subdomain the site redirects to (e.g. an auth subdomain) before starting a session.",
  {
    target: z.string().describe("Origin to proxy, e.g. https://accounts.skilljar.com"),
    port: z.number().optional().describe("Port to use — auto-assigned starting at 9989 if omitted"),
  },
  async ({ target, port }) => {
    try {
      const assignedPort = await addTargetOrigin(target, port);
      const activeTargets = getActiveTargets();
      const list = activeTargets.map(t => `  http://localhost:${t.port} → ${t.origin}`).join("\n");
      return {
        content: [{
          type: "text",
          text: `Target added: http://localhost:${assignedPort} → ${target}\n\nAll active proxies:\n${list}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error adding target: ${e.message}` }] };
    }
  }
);

// ----- remove_target ------------------------------------------------------

mcp.tool(
  "remove_target",
  "Remove a proxy target by port number or origin URL. The primary proxy port is cleared but its server stays running.",
  {
    port: z.number().optional().describe("Port number of the target to remove"),
    target: z.string().optional().describe("Origin URL of the target to remove"),
  },
  async ({ port, target }) => {
    let targetPort = port;
    if (!targetPort && target) {
      for (const [p, e] of targets) {
        if (e.origin === target) { targetPort = p; break; }
      }
    }
    if (!targetPort) {
      return { content: [{ type: "text", text: "Specify a port or target URL to remove." }] };
    }
    try {
      await removeTargetPort(targetPort);
      const activeTargets = getActiveTargets();
      const msg = activeTargets.length > 0
        ? `Remaining proxies:\n${activeTargets.map(t => `  http://localhost:${t.port} → ${t.origin}`).join("\n")}`
        : "No active proxies remaining.";
      return { content: [{ type: "text", text: `Target on port ${targetPort} removed.\n${msg}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// ----- list_targets -------------------------------------------------------

mcp.tool(
  "list_targets",
  "List all active proxy targets with their ports and local URLs.",
  {},
  async () => {
    const activeTargets = getActiveTargets();
    if (activeTargets.length === 0) {
      return { content: [{ type: "text", text: "No active proxies. Use start_proxy to begin." }] };
    }
    const lines = activeTargets.map(t => `  http://localhost:${t.port} → ${t.origin}`).join("\n");
    return { content: [{ type: "text", text: `Active proxies:\n${lines}` }] };
  }
);

// ----- switch_theme -------------------------------------------------------

mcp.tool(
  "switch_theme",
  "Hot-swap the active theme without restarting the proxy",
  {
    userstyle: z
      .string()
      .describe('Path to a .user.css file, or empty string "" to remove the theme'),
  },
  async ({ userstyle }) => {
    if (!userstyle) {
      themeCSS = ""; themeName = ""; themeFile = "";
      broadcast("theme-cleared", null);
      return { content: [{ type: "text", text: "Theme removed." }] };
    }
    try {
      const { name } = await loadTheme(userstyle);
      broadcast("theme-changed", themeCSS);
      return { content: [{ type: "text", text: `Switched to theme: ${name}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error loading theme: ${e.message}` }] };
    }
  }
);

// ----- inject_css ---------------------------------------------------------

mcp.tool(
  "inject_css",
  "Append ad-hoc CSS on top of the current theme (additive, does not replace the theme)",
  {
    css: z.string().describe("Raw CSS string to inject"),
    id: z
      .string()
      .optional()
      .describe("Snippet ID — reuse to replace a previous snippet"),
  },
  async ({ css, id }) => {
    const sid = id || `adhoc-${++snippetCounter}`;
    adhocSnippets.set(sid, css);
    broadcast("snippets-updated", [...adhocSnippets.values()].join("\n"));
    return {
      content: [{
        type: "text",
        text: `Injected snippet "${sid}" (${css.length} chars). ${adhocSnippets.size} active snippet(s).`,
      }],
    };
  }
);

// ----- list_userstyles ----------------------------------------------------

mcp.tool(
  "list_userstyles",
  "Scan a directory for .user.css files and return their metadata. Always call this first to get the correct absolute path before switching themes.",
  {
    directory: z
      .string()
      .describe("Absolute or relative path to a directory containing .user.css files"),
  },
  async ({ directory }) => {
    const dir = path.resolve(directory);
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return { content: [{ type: "text", text: `Cannot read directory: ${dir}` }] };
    }
    const files = entries.filter((f) => f.endsWith(".user.css"));
    if (files.length === 0) {
      return { content: [{ type: "text", text: `No .user.css files found in ${dir}` }] };
    }
    const results = [];
    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(path.join(dir, file), "utf8");
        const meta = parseMetadata(raw);
        results.push({
          file,
          path: path.join(dir, file),
          name: meta.name || file,
          version: meta.version || "",
          description: meta.description || "",
        });
      } catch {
        results.push({ file, error: "Could not read file" });
      }
    }
    lastScanDir = dir;
    lastScanFiles = results;
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ----- refresh_theme ------------------------------------------------------

mcp.tool(
  "refresh_theme",
  "Force a full CSS re-render by cycling the active theme off then back on. Use when style changes are not visually applying correctly.",
  {},
  async () => {
    if (!themeCSS) {
      return { content: [{ type: "text", text: "No theme active, nothing to refresh." }] };
    }
    const savedCSS = themeCSS;
    broadcast("theme-cleared", null);
    await new Promise(r => setTimeout(r, 50));
    broadcast("theme-changed", savedCSS);
    return { content: [{ type: "text", text: "Theme refreshed." }] };
  }
);

// ----- get_current_theme --------------------------------------------------

mcp.tool(
  "get_current_theme",
  "Return the currently active theme name and file path, plus all active proxy targets. Use this to understand the current state before making changes.",
  {},
  async () => {
    const activeTargets = getActiveTargets();
    const targetList = activeTargets.length > 0
      ? activeTargets.map(t => `  http://localhost:${t.port} → ${t.origin}`).join("\n")
      : "  (none — panel-only mode)";

    if (!themeName && !themeFile) {
      return {
        content: [{
          type: "text",
          text: `No theme loaded.\n\nActive proxies:\n${targetList}`,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: `Active theme: ${themeName}\nFile: ${themeFile}\n\nActive proxies:\n${targetList}`,
      }],
    };
  }
);

// ----- stop_proxy ---------------------------------------------------------

mcp.tool(
  "stop_proxy",
  "Deactivate all reverse proxies — clears all targets and the theme. The panel remains available at /__panel__.",
  {},
  async () => {
    await stopAllTargets();
    resetState();
    return {
      content: [{
        type: "text",
        text: `All proxies stopped. Panel still available at http://localhost:${PORT}/__panel__`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start MCP transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await mcp.connect(transport);
