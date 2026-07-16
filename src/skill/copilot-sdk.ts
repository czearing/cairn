import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { ClaudeOpts, ClaudeResult } from "./types";

let clientPromise: Promise<CopilotClient> | null = null;

async function client(): Promise<CopilotClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const instance = new CopilotClient({
        mode: "empty",
        baseDirectory: process.env.COPILOT_HOME || join(homedir(), ".copilot"),
        workingDirectory: process.cwd(),
        logLevel: "error",
        env: { ...process.env, CAIRN_SKILL_WORKER: "1" },
      });
      await instance.start();
      return instance;
    })();
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

const searchTool = defineTool("brain_search", {
  description: "Return the most relevant prior Cairn thoughts for this review.",
  parameters: z.object({ query: z.string() }),
  skipPermission: true,
  defer: "never",
  handler: async ({ query }) => {
    const { search } = await import("../core/search");
    return JSON.stringify((await search(query)).slice(0, 8));
  },
});

function outputTool(env: Record<string, string>) {
  return defineTool("skill_output", {
    description: "Submit the completed skill review exactly once.",
    parameters: z.object({
      score: z.number().min(0).max(1),
      right: z.string(),
      wrong: z.string(),
      improve: z.string(),
      master: z.string(),
      explanation: z.string(),
    }),
    skipPermission: true,
    defer: "never",
    handler: (result) => {
      const label = (env.CAIRN_SKILL_FORCED_LABEL || "").trim();
      if (label && (!result.master.trim() || !result.explanation.trim())) {
        throw new Error("master and explanation are required for a labeled review");
      }
      const path = env.CAIRN_SKILL_OUTPUT_PATH;
      if (!path) throw new Error("review output path is unavailable");
      writeFileSync(path, JSON.stringify({ ...result, label }));
      return { ok: true };
    },
  });
}

export async function runCopilotSdk(prompt: string, opts: ClaudeOpts = {}): Promise<ClaudeResult> {
  const env = opts.env ?? {};
  const sessionId = `cairn-review-${randomUUID()}`;
  let instance: CopilotClient | undefined;
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  try {
    instance = await client();
    session = await instance.createSession({
      sessionId,
      model: opts.model,
      systemMessage: { mode: "replace", content: opts.system || "Complete the requested review." },
      tools: [searchTool, outputTool(env)],
      availableTools: ["custom:brain_search", "custom:skill_output"],
    });
    const response = await session.sendAndWait(prompt, opts.timeoutMs ?? 180_000);
    return { ok: true, text: response?.data.content ?? "" };
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { await session?.disconnect(); } catch { /* session is already gone */ }
    try { await instance?.deleteSession(sessionId); } catch { /* cleanup is best-effort */ }
  }
}

export async function stopCopilotSdk(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    const instance = await pending;
    const stopped = await Promise.race([
      instance.stop().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!stopped) await instance.forceStop();
  } catch { /* process exit is the final cleanup */ }
}
