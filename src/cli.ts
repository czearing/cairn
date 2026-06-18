#!/usr/bin/env bun
// Cairn CLI. Installed as the `cairn` binary (see package.json "bin").

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "--version":
  case "-v":
  case "version": {
    const { version } = (await import("../package.json")).default as { version: string };
    console.log(`cairn ${version}`);
    break;
  }
  case "install":
    await (await import("./install")).install({ dryRun: process.argv.includes("--dry-run") });
    break;
  case "update":
    await (await import("./update")).update();
    break;
  case "sync":
    await (await import("./sync")).sync(process.argv.slice(3));
    break;
  case "uninstall":
    await (await import("./uninstall")).uninstall();
    break;
  case "doctor": {
    const ok = await (await import("./doctor")).doctor();
    if (!ok) process.exitCode = 1;
    break;
  }
  case "verify": {
    const { verify } = await import("./verify");
    const { c, sym, line } = await import("./term");
    const v = await verify();
    if (v.ok) {
      line(`${sym.ok} ${c.green("Brain verified.")} Created and recalled a memory ${c.dim(`(warm ${v.warmMs}ms, recall ${v.smokeMs}ms)`)}`);
    } else {
      line(`${sym.bad} ${c.red("Verification failed")} ${c.dim(v.error ?? "")}`);
      line(`  ${sym.arrow} Check your connection (the local model downloads once) or your CAIRN_EMBED_* settings, then retry ${c.cyan("cairn verify")}.`);
      process.exitCode = 1;
    }
    break;
  }
  case "__smoke": {
    // Hidden: runs the isolated smoke test in this clean child process and prints a JSON result.
    const v = await (await import("./verify")).smokeMain();
    console.log(JSON.stringify(v));
    break;
  }
  case "proxy": {
    const { start } = await import("./proxy/server");
    const { c, sym, line } = await import("./term");
    const s = start();
    line(`${sym.ok} ${c.green("Cairn proxy")} on ${c.cyan(`http://localhost:${s.port}/v1`)}  ->  ${s.upstream.name} ${c.dim(`(${s.upstream.baseUrl})`)}`);
    line(c.dim(`   Point your OpenAI client's base_url at http://localhost:${s.port}/v1. Memory is recalled automatically.`));
    line(c.dim(`   Switch backend with CAIRN_PROXY_UPSTREAM (ollama, openai) or CAIRN_PROXY_BASE_URL.`));
    break;
  }
  case "mcp":
    await import("./mcp/server"); // starts the stdio server (connects on import)
    break;
  case "ui": {
    const server = (await import("./ui/server")).start();
    console.log(`Cairn viewer → http://localhost:${server.port}`);
    break;
  }
  case "seed":
    await import("../examples/seed");
    break;
  default:
    console.log(`cairn: a shared semantic-graph memory for AI agents

Usage:
  cairn install     Preflight, register hooks + the MCP server, warm the model, verify
  cairn install --dry-run   Show what install WOULD change, writing nothing (safe rehearsal)
  cairn doctor      Check your environment and print the fix for anything missing
  cairn verify      Prove the brain works: create & recall a memory in a throwaway DB
  cairn update      Pull the latest version, reinstall deps, re-apply config
  cairn sync        Connect this device to a shared cloud brain, or show/copy the connection
  cairn sync <url> <token>   Validate + save cloud creds so every device shares one brain
  cairn uninstall   Remove Cairn's hooks and MCP registration from Claude Code
  cairn --version   Print the installed version
  cairn proxy       Run the OpenAI-compatible memory proxy (recall for Ollama and others)
  cairn mcp         Run the MCP server over stdio
  cairn ui          Serve the read-only viewer (deep-linkable at /node/<id>)
  cairn seed        Write a few demo neurons to the brain

Config (env): CAIRN_DB_PATH, CAIRN_EMBED_PROVIDER, CAIRN_RELEVANCE_THRESHOLD …
Docs: https://github.com/czearing/cairn`);
}
