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
    // The embedding runtime (ONNX/transformers) leaves handles open, so the process won't exit on its
    // own — forcing the parent's `await proc.exited` to hang. Exit now that the result is flushed.
    process.exit(0);
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
  case "compact": {
    const { compact } = await import("./core/compact");
    const { c, sym, line, step } = await import("./term");
    const mb = (b: number) => `${(b / 1048576).toFixed(2)} MB`;
    try {
      line(c.bold("\nCairn compact: reclaiming dead pages\n"));
      const r = compact({ backup: !process.argv.includes("--no-backup") });
      const saved = r.beforeBytes - r.afterBytes;
      const pct = r.beforeBytes > 0 ? Math.round((100 * saved) / r.beforeBytes) : 0;
      step(`${sym.ok} ${mb(r.beforeBytes)} ${sym.arrow} ${mb(r.afterBytes)}  ${c.green(`(${mb(saved)} reclaimed, ${pct}% smaller)`)}`);
      step(`${sym.dot} ${r.rows} thoughts preserved · integrity ${r.integrityOk ? c.green("ok") : c.red("FAILED")}`);
      if (r.backupPath) step(`${sym.dot} backup ${c.dim(r.backupPath.replace(/\\/g, "/"))}`);
      if (!r.integrityOk) { line(`\n${sym.bad} ${c.red("integrity check failed — restore the backup above.")}`); process.exitCode = 1; }
      line();
    } catch (err) {
      line(`${sym.bad} ${c.red("compact failed")} ${c.dim(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = 1;
    }
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
  cairn uninstall   Remove Cairn's hooks and MCP registration from Claude Code
  cairn --version   Print the installed version
  cairn proxy       Run the OpenAI-compatible memory proxy (recall for Ollama and others)
  cairn mcp         Run the MCP server over stdio
  cairn compact     Reclaim freed space in the brain (safe; writes a backup first; stop the server first)
  cairn ui          Serve the read-only viewer (deep-linkable at /node/<id>)
  cairn seed        Write a few demo neurons to the brain

Config (env): CAIRN_DB_PATH, CAIRN_EMBED_PROVIDER, CAIRN_RELEVANCE_THRESHOLD …
Docs: https://github.com/czearing/cairn`);
}
