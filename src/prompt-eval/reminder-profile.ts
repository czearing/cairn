import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { postToolPromptFiles } from "../inject/post-tool";
import { recordBenchmarkContext } from "./benchmark-record";

export function benchmarkReminder(tool: string, input: unknown): string {
  const dir = process.env.CAIRN_PROMPT_BENCHMARK_DIR;
  if (!process.env.CAIRN_PROMPT_BENCHMARK_SESSION || !dir) return "";
  const answer = typeof input === "object" && input
    && typeof (input as { answer?: unknown }).answer === "string"
    ? String((input as { answer: string }).answer)
    : "";
  const blocks = postToolPromptFiles(tool, answer).map((file) => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  }).filter(Boolean);
  const text = blocks.join("\n\n");
  const wrapped = text ? `<cairn-internal>\n${text}\n</cairn-internal>` : "";
  recordBenchmarkContext(wrapped);
  return wrapped;
}

export function appendBenchmarkReminder<T>(result: T, reminder: string): T {
  if (!reminder || !result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: [...content, { type: "text", text: reminder }],
  };
}
