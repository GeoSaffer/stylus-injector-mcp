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

let targetOrigin = null;   // null = panel-only mode; string = proxy active
let hostPattern = null;
let themeCSS = "";
let themeName = "";
let themeFile = "";
const adhocSnippets = new Map();
let snippetCounter = 0;

function setTarget(origin) {
  targetOrigin = origin || null;
  hostPattern = targetOrigin
    ? new RegExp(
        `https?://${new URL(targetOrigin).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "gi"
      )
    : null;
}

function resetState() {
  themeCSS = "";
  themeName = "";
  themeFile = "";
  adhocSnippets.clear();
  snippetCounter = 0;
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
  const parts = ["\n<!-- Injected by stylus-injector MCP -->"];
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
// Proxy request handler
// ---------------------------------------------------------------------------

function proxyRequest(req, res) {
  const url = new URL(targetOrigin);
  const secure = url.protocol === "https:";
  const doRequest = secure ? https.request : http.request;

  const headers = { ...req.headers, host: url.host };
  if (headers.referer) {
    headers.referer = headers.referer.replace(`http://localhost:${PORT}`, url.origin);
  }
  if (headers.origin && headers.origin.includes(`localhost:${PORT}`)) {
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
    const hasCSS = !!(themeCSS || adhocSnippets.size > 0);

    if (proxyRes.headers.location) {
      proxyRes.headers.location = proxyRes.headers.location.replace(
        hostPattern,
        `http://localhost:${PORT}`
      );
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

    if (ct.includes("text/html") && hasCSS) {
      const decoded = decompress(proxyRes, proxyRes.headers["content-encoding"]);
      const chunks = [];
      decoded.on("data", (c) => chunks.push(c));
      decoded.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        const tag = injectionBlock();
        if (/<\/head>/i.test(body)) body = body.replace(/<\/head>/i, tag + "</head>");
        else if (/<\/body>/i.test(body)) body = body.replace(/<\/body>/i, tag + "</body>");
        else body += tag;

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
        res.end(`Decompression error: ${e.message}`);
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
        target: targetOrigin,
        port: PORT,
        theme: { name: themeName || "", file: themeFile || "" },
        snippets: [...adhocSnippets.entries()].map(([id, css]) => ({
          id,
          preview: css.slice(0, 120),
          length: css.length,
        })),
      });
    }

    // POST /start-proxy
    if (req.method === "POST" && route === "/start-proxy") {
      const { target, userstyle } = await readBody(req);
      if (!target) return jsonResponse(res, 400, { error: "Missing target URL" });
      setTarget(target);
      resetState();
      let theme = "";
      if (userstyle) {
        const { name } = await loadTheme(userstyle);
        theme = name;
      }
      return jsonResponse(res, 200, { target, theme, port: PORT });
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
          files.push({ file, path: path.join(dir, file), name: meta.name || file, version: meta.version || "", description: meta.description || "" });
        } catch {
          files.push({ file, error: "Could not read file" });
        }
      }
      return jsonResponse(res, 200, { files });
    }

    // POST /switch-theme
    if (req.method === "POST" && route === "/switch-theme") {
      const { userstyle } = await readBody(req);
      if (userstyle === undefined) return jsonResponse(res, 400, { error: "Missing userstyle field" });
      if (!userstyle) {
        themeCSS = ""; themeName = ""; themeFile = "";
        return jsonResponse(res, 200, { name: "", message: "Theme cleared" });
      }
      const { name } = await loadTheme(userstyle);
      return jsonResponse(res, 200, { name, message: `Switched to ${name}` });
    }

    // POST /inject-css
    if (req.method === "POST" && route === "/inject-css") {
      const { css, id } = await readBody(req);
      if (!css) return jsonResponse(res, 400, { error: "Missing css field" });
      const sid = id || `adhoc-${++snippetCounter}`;
      adhocSnippets.set(sid, css);
      return jsonResponse(res, 200, { id: sid, count: adhocSnippets.size });
    }

    // POST /remove-snippet
    if (req.method === "POST" && route === "/remove-snippet") {
      const { id } = await readBody(req);
      if (!id) return jsonResponse(res, 400, { error: "Missing id field" });
      adhocSnippets.delete(id);
      return jsonResponse(res, 200, { removed: id, count: adhocSnippets.size });
    }

    // POST /clear-snippets
    if (req.method === "POST" && route === "/clear-snippets") {
      adhocSnippets.clear();
      return jsonResponse(res, 200, { message: "All snippets cleared" });
    }

    // POST /stop
    if (req.method === "POST" && route === "/stop") {
      setTarget(null);
      resetState();
      return jsonResponse(res, 200, { message: "Proxy stopped. Panel still available." });
    }

    jsonResponse(res, 404, { error: "Unknown API route" });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// HTTP server — starts immediately when MCP server loads
// Panel is always available at http://localhost:PORT/__panel__
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // Serve control panel (always available)
  if (req.url === "/__panel__" || req.url === "/__panel__/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(panelHTML),
    });
    res.end(panelHTML);
    return;
  }

  // API routes (always available)
  if (req.url.startsWith("/__api__/")) {
    handleAPI(req, res).catch((e) => jsonResponse(res, 500, { error: e.message }));
    return;
  }

  // No target set — redirect to panel
  if (!targetOrigin) {
    res.writeHead(302, { Location: "/__panel__" });
    res.end();
    return;
  }

  // Proxy mode — forward to target
  proxyRequest(req, res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write(
      `[stylus-injector] Port ${PORT} is already in use. Set STYLUS_PORT env var in mcp.json to use a different port.\n`
    );
  } else {
    process.stderr.write(`[stylus-injector] Server error: ${e.message}\n`);
  }
});

server.listen(PORT, () => {
  process.stderr.write(
    `[stylus-injector] Panel ready: http://localhost:${PORT}/__panel__\n`
  );
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
  "Activate the reverse proxy — sets the target site and optionally loads a theme. The panel is always available at /__panel__ regardless.",
  {
    target: z.string().describe("Origin to proxy, e.g. https://example.com"),
    userstyle: z
      .string()
      .optional()
      .describe("Absolute or relative path to a .user.css file to inject"),
  },
  async ({ target, userstyle }) => {
    setTarget(target);
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
        text: `Proxy active: ${localUrl} → ${target}${themeInfo}\n\nEmbedded browser: ${localUrl}\nControl panel:    ${localUrl}/__panel__`,
      }],
    };
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
      return { content: [{ type: "text", text: "Theme removed. Refresh the page." }] };
    }
    try {
      const { name } = await loadTheme(userstyle);
      return { content: [{ type: "text", text: `Switched to theme: ${name}. Refresh the page.` }] };
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
    return {
      content: [{
        type: "text",
        text: `Injected snippet "${sid}" (${css.length} chars). ${adhocSnippets.size} active snippet(s). Refresh the page.`,
      }],
    };
  }
);

// ----- list_userstyles ----------------------------------------------------

mcp.tool(
  "list_userstyles",
  "Scan a directory for .user.css files and return their metadata",
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
        results.push({ file, path: path.join(dir, file), name: meta.name || file, version: meta.version || "", description: meta.description || "" });
      } catch {
        results.push({ file, error: "Could not read file" });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ----- stop_proxy ---------------------------------------------------------

mcp.tool(
  "stop_proxy",
  "Deactivate the reverse proxy — clears the target and theme. The panel remains available at /__panel__.",
  {},
  async () => {
    setTarget(null);
    resetState();
    return {
      content: [{
        type: "text",
        text: `Proxy stopped. Panel still available at http://localhost:${PORT}/__panel__`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start MCP transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await mcp.connect(transport);
