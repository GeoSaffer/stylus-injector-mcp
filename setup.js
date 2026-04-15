#!/usr/bin/env node

/**
 * Prints the mcp.json snippet needed to register this MCP server in Cursor.
 * Run:  npm run setup   (or:  node setup.js)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "index.js");

const snippet = {
  "stylus-injector": {
    command: "node",
    args: [indexPath],
  },
};

const mcpJsonPath = path.join(os.homedir(), ".cursor", "mcp.json");

console.log("");
console.log("=== Stylus Injector MCP — Setup ===");
console.log("");
console.log("Add this to your Cursor MCP config:");
console.log("");
console.log(`  File: ${mcpJsonPath}`);
console.log("");
console.log("  Merge into the \"mcpServers\" object:");
console.log("");
console.log(JSON.stringify(snippet, null, 2));
console.log("");

let wrote = false;
try {
  let config = { mcpServers: {} };
  if (fs.existsSync(mcpJsonPath)) {
    config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
    if (!config.mcpServers) config.mcpServers = {};
  }

  if (config.mcpServers["stylus-injector"]) {
    const existing = config.mcpServers["stylus-injector"];
    if (existing.args?.[0] === indexPath) {
      console.log("Already registered in mcp.json — no changes needed.");
      wrote = true;
    } else {
      console.log("Existing entry found with a different path. Updating...");
      config.mcpServers["stylus-injector"] = snippet["stylus-injector"];
      const dir = path.dirname(mcpJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`Updated: ${mcpJsonPath}`);
      wrote = true;
    }
  } else {
    config.mcpServers["stylus-injector"] = snippet["stylus-injector"];
    const dir = path.dirname(mcpJsonPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`Registered in: ${mcpJsonPath}`);
    wrote = true;
  }
} catch (e) {
  console.log(`Could not auto-register: ${e.message}`);
  console.log("Please add the snippet above to your mcp.json manually.");
}

if (wrote) {
  console.log("");
  console.log("Restart Cursor (or reload MCP servers) to activate.");
}
console.log("");
