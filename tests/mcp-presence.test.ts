import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, openSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../src/core/config";
import { mcpAvailable } from "../src/mcp/presence";

const original = process.env.CAIRN_MCP_AVAILABLE;
afterEach(() => {
  if (original == null) delete process.env.CAIRN_MCP_AVAILABLE;
  else process.env.CAIRN_MCP_AVAILABLE = original;
});

test("MCP presence requires a fresh heartbeat from the same host process", () => {
  process.env.CAIRN_MCP_AVAILABLE = "auto";
  const parentPid = 987_654;
  const marker = join(dirname(config.dbPath), `${basename(config.dbPath)}.mcp-${parentPid}-123`);
  closeSync(openSync(marker, "w"));
  expect(mcpAvailable(Date.now(), parentPid)).toBe(true);

  const stale = new Date(Date.now() - 10_000);
  utimesSync(marker, stale, stale);
  expect(mcpAvailable(Date.now(), parentPid)).toBe(false);
  expect(existsSync(marker)).toBe(false);
  rmSync(marker, { force: true });
});
