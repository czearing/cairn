// An upstream is the model backend the proxy forwards to. Each one is just a base URL and a key,
// because Ollama, OpenAI, and most local servers all speak the same /v1/chat/completions shape.
// Switch with CAIRN_PROXY_UPSTREAM, or point at anything with CAIRN_PROXY_BASE_URL.

export interface Upstream {
  name: string;
  baseUrl: string;
  apiKey: string;
}

const PRESETS: Record<string, { baseUrl: string; keyEnv?: string; defaultKey?: string }> = {
  // Ollama ignores the key but the OpenAI shape wants one present.
  ollama: { baseUrl: "http://localhost:11434/v1", defaultKey: "ollama" },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
};

export function listUpstreams(): string[] {
  return Object.keys(PRESETS);
}

export function resolveUpstream(): Upstream {
  const name = process.env.CAIRN_PROXY_UPSTREAM || "ollama";
  const preset = PRESETS[name];
  const baseUrl = (process.env.CAIRN_PROXY_BASE_URL || preset?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      `Unknown upstream "${name}". Use one of ${listUpstreams().join(", ")}, or set CAIRN_PROXY_BASE_URL.`
    );
  }
  const fromEnv = preset?.keyEnv ? process.env[preset.keyEnv] : undefined;
  const apiKey = process.env.CAIRN_PROXY_API_KEY || fromEnv || preset?.defaultKey || "";
  return { name, baseUrl, apiKey };
}
