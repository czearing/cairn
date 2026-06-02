#!/usr/bin/env bun
// Cairn CLI. Installed as the `cairn` binary (see package.json "bin").

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "install":
    await (await import("./install")).install();
    break;
  case "mcp":
    await import("./mcp/server"); // starts the stdio server (connects on import)
    break;
  case "seed":
    await import("../examples/seed");
    break;
  default:
    console.log(`cairn — a shared semantic-graph memory for AI agents

Usage:
  cairn install   Register hooks + the MCP server with Claude Code
  cairn mcp       Run the MCP server over stdio
  cairn seed      Write a few demo neurons to the brain

Config (env): CAIRN_DB_PATH, CAIRN_EMBED_PROVIDER, CAIRN_RELEVANCE_THRESHOLD …
Docs: https://github.com/cairn-memory/cairn`);
}
