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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelHTML = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");

let proxyServer = null;
let proxyPort = 9988;
let targetOrigin = null;
let themeCSS = "";
let themeName = "";
let themeFile = "";
const adhocSnippets = new Map();
let snippetCounter = 0;

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
// Reverse proxy
// ---------------------------------------------------------------------------

function decompress(stream, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip":
      return stream.pipe(zlib.createGunzip());
    case "br":
      return stream.pipe(zlib.createBrotliDecompress());
    case "deflate":
      return stream.pipe(zlib.createInflate());
    default:
      return stream;
  }
}

function createProxy(target, port) {
  const url = new URL(target);
  const secure = url.protocol === "https:";
  const doRequest = secure ? https.request : http.request;
  const hostPattern = new RegExp(
    `https?://${url.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "gi"
  );

  return http.createServer((req, res) => {
    // Serve control panel
    if (req.url === "/__panel__" || req.url === "/__panel__/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(panelHTML),
      });
      res.end(panelHTML);
      return;
    }

    // Handle API routes
    if (req.url.startsWith("/__api__/")) {
      handleAPI(req, res).catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    const headers = { ...req.headers, host: url.host };

    if (headers.referer) {
      headers.referer = headers.referer.replace(
        `http://localhost:${port}`,
        url.origin
      );
    }
    if (headers.origin && headers.origin.includes(`localhost:${port}`)) {
      headers.origin = url.origin;
    }

    // Ask upstream for uncompressed so we can inject into HTML easily
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

      // Rewrite redirect Location back to localhost
      if (proxyRes.headers.location) {
        proxyRes.headers.location = proxyRes.headers.location.replace(
          hostPattern,
          `http://localhost:${port}`
        );
      }

      // Strip headers that block local dev
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["content-security-policy-report-only"];
      delete proxyRes.headers["strict-transport-security"];
      delete proxyRes.headers["x-frame-options"];

      // Rewrite Set-Cookie domain/secure so cookies work on localhost
      if (proxyRes.headers["set-cookie"]) {
        const cookies = Array.isArray(proxyRes.headers["set-cookie"])
          ? proxyRes.headers["set-cookie"]
          : [proxyRes.headers["set-cookie"]];
        proxyRes.headers["set-cookie"] = cookies.map((c) =>
          c.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*secure/gi, "")
        );
      }

      // HTML with CSS to inject → buffer, inject, forward
      if (ct.includes("text/html") && hasCSS) {
        const decoded = decompress(proxyRes, proxyRes.headers["content-encoding"]);
        const chunks = [];

        decoded.on("data", (c) => chunks.push(c));
        decoded.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf8");
          const tag = injectionBlock();

          if (/<\/head>/i.test(body)) {
            body = body.replace(/<\/head>/i, tag + "</head>");
          } else if (/<\/body>/i.test(body)) {
            body = body.replace(/<\/body>/i, tag + "</body>");
          } else {
            body += tag;
          }

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
        // Non-HTML or no CSS → passthrough
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (e) => {
      res.writeHead(502);
      res.end(`Proxy error: ${e.message}`);
    });

    req.pipe(proxyReq);
  });
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
// Control panel API  (served at /__panel__ and /__api__/*)
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
  const reqUrl = new URL(req.url, `http://localhost:${proxyPort}`);
  const route = reqUrl.pathname.replace("/__api__", "");

  try {
    if (req.method === "GET" && route === "/status") {
      return jsonResponse(res, 200, {
        target: targetOrigin,
        port: proxyPort,
        theme: { name: themeName || "", file: themeFile || "" },
        snippets: [...adhocSnippets.entries()].map(([id, css]) => ({
          id,
          preview: css.slice(0, 120),
          length: css.length,
        })),
      });
    }

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
      return jsonResponse(res, 200, { files });
    }

    if (req.method === "POST" && route === "/switch-theme") {
      const { userstyle } = await readBody(req);
      if (!userstyle && userstyle !== "") {
        return jsonResponse(res, 400, { error: "Missing userstyle field" });
      }
      if (!userstyle) {
        themeCSS = "";
        themeName = "";
        themeFile = "";
        return jsonResponse(res, 200, { name: "", message: "Theme cleared" });
      }
      const { name } = await loadTheme(userstyle);
      return jsonResponse(res, 200, { name, message: `Switched to ${name}` });
    }

    if (req.method === "POST" && route === "/inject-css") {
      const { css, id } = await readBody(req);
      if (!css) return jsonResponse(res, 400, { error: "Missing css field" });
      const sid = id || `adhoc-${++snippetCounter}`;
      adhocSnippets.set(sid, css);
      return jsonResponse(res, 200, { id: sid, count: adhocSnippets.size });
    }

    if (req.method === "POST" && route === "/remove-snippet") {
      const { id } = await readBody(req);
      if (!id) return jsonResponse(res, 400, { error: "Missing id field" });
      adhocSnippets.delete(id);
      return jsonResponse(res, 200, { removed: id, count: adhocSnippets.size });
    }

    if (req.method === "POST" && route === "/clear-snippets") {
      adhocSnippets.clear();
      return jsonResponse(res, 200, { message: "All snippets cleared" });
    }

    if (req.method === "POST" && route === "/stop") {
      const freedPort = proxyPort;
      setTimeout(() => {
        if (proxyServer) {
          proxyServer.close();
          proxyServer = null;
          targetOrigin = null;
          themeCSS = "";
          themeName = "";
          themeFile = "";
          adhocSnippets.clear();
          snippetCounter = 0;
        }
      }, 100);
      return jsonResponse(res, 200, { message: `Proxy stopping on port ${freedPort}` });
    }

    jsonResponse(res, 404, { error: "Unknown API route" });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

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
  "Start a local reverse proxy that injects Stylus theme CSS into every HTML response",
  {
    target: z.string().describe("Origin to proxy, e.g. https://example.com"),
    userstyle: z
      .string()
      .optional()
      .describe("Absolute or relative path to a .user.css file to inject"),
    port: z
      .number()
      .optional()
      .describe("Local port to listen on (default 9988)"),
  },
  async ({ target, userstyle, port }) => {
    if (proxyServer) {
      return {
        content: [
          {
            type: "text",
            text: "Error: proxy already running. Call stop_proxy first.",
          },
        ],
      };
    }

    targetOrigin = target;
    proxyPort = port || 9988;
    themeCSS = "";
    themeName = "";
    themeFile = "";
    adhocSnippets.clear();
    snippetCounter = 0;

    let themeInfo = "";
    if (userstyle) {
      try {
        const { name } = await loadTheme(userstyle);
        themeInfo = `\nTheme: ${name}`;
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error loading theme: ${e.message}` },
          ],
        };
      }
    }

    proxyServer = createProxy(targetOrigin, proxyPort);
    try {
      await new Promise((resolve, reject) => {
        proxyServer.once("error", reject);
        proxyServer.listen(proxyPort, () => resolve());
      });
    } catch (e) {
      proxyServer = null;
      return {
        content: [
          { type: "text", text: `Error starting proxy: ${e.message}` },
        ],
      };
    }

    const localUrl = `http://localhost:${proxyPort}`;
    return {
      content: [
        {
          type: "text",
          text: `Proxy started: ${localUrl} → ${targetOrigin}${themeInfo}\n\nNavigate to ${localUrl} in the Cursor embedded browser.\nControl panel: ${localUrl}/__panel__`,
        },
      ],
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
      .describe(
        'Path to a .user.css file, or empty string "" to remove the theme (passthrough)'
      ),
  },
  async ({ userstyle }) => {
    if (!proxyServer) {
      return {
        content: [
          {
            type: "text",
            text: "Error: no proxy running. Call start_proxy first.",
          },
        ],
      };
    }
    if (!userstyle) {
      themeCSS = "";
      themeName = "";
      themeFile = "";
      return {
        content: [
          {
            type: "text",
            text: "Theme removed. Proxy is now passthrough. Refresh the page.",
          },
        ],
      };
    }
    try {
      const { name } = await loadTheme(userstyle);
      return {
        content: [
          {
            type: "text",
            text: `Switched to theme: ${name}. Refresh the page to see changes.`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          { type: "text", text: `Error loading theme: ${e.message}` },
        ],
      };
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
    if (!proxyServer) {
      return {
        content: [
          {
            type: "text",
            text: "Error: no proxy running. Call start_proxy first.",
          },
        ],
      };
    }
    const sid = id || `adhoc-${++snippetCounter}`;
    adhocSnippets.set(sid, css);
    return {
      content: [
        {
          type: "text",
          text: `Injected snippet "${sid}" (${css.length} chars). ${adhocSnippets.size} active snippet(s). Refresh the page.`,
        },
      ],
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
      return {
        content: [{ type: "text", text: `Cannot read directory: ${dir}` }],
      };
    }
    const files = entries.filter((f) => f.endsWith(".user.css"));
    if (files.length === 0) {
      return {
        content: [
          { type: "text", text: `No .user.css files found in ${dir}` },
        ],
      };
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
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ----- stop_proxy ---------------------------------------------------------

mcp.tool(
  "stop_proxy",
  "Shut down the reverse proxy and free the port",
  {},
  async () => {
    if (!proxyServer) {
      return {
        content: [{ type: "text", text: "No proxy is running." }],
      };
    }
    await new Promise((resolve) => proxyServer.close(resolve));
    const freedPort = proxyPort;
    proxyServer = null;
    targetOrigin = null;
    themeCSS = "";
    themeName = "";
    themeFile = "";
    adhocSnippets.clear();
    snippetCounter = 0;
    return {
      content: [
        { type: "text", text: `Proxy stopped. Port ${freedPort} freed.` },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await mcp.connect(transport);
