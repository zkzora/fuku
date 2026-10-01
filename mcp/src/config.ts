/**
 * Configuration from the environment (the MCP client's `env` block). Validated at startup; a bad
 * value stops the server with a message on stderr. A private key is never echoed back.
 */
export interface Config {
  /** Fuku app, e.g. http://localhost:3001 */
  baseUrl: string;
  /** The owner's API key (fk_live_…). */
  apiKey: string;
  /** The Fuku agent this assistant acts as. */
  agentId: string;
  /** The agent's own key (0x + 64 hex), registered as its ERC-8004 agentWallet. Null: read-only. */
  agentPrivateKey: `0x${string}` | null;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Fuku MCP server: invalid configuration\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const AGENT_ID = /^fuku:agent:0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const baseUrl = env.FUKU_BASE_URL?.trim() ?? "";
  if (!baseUrl) problems.push("FUKU_BASE_URL is not set (the Fuku app, e.g. http://localhost:3001).");
  else {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") problems.push(`FUKU_BASE_URL must be http(s), got ${u.protocol}`);
    } catch {
      problems.push(`FUKU_BASE_URL is not a URL: ${JSON.stringify(baseUrl)}`);
    }
  }
  const apiKey = env.FUKU_API_KEY?.trim() ?? "";
  if (!apiKey) problems.push("FUKU_API_KEY is not set (the owner's API key from the Developer Console).");
  else if (apiKey.startsWith("<")) problems.push("FUKU_API_KEY is still a placeholder: copy the key from mcp/.env, or remove the line.");
  const agentId = env.FUKU_AGENT_ID?.trim() ?? "";
  if (!agentId) problems.push("FUKU_AGENT_ID is not set (the Fuku agent this assistant acts as).");
  else if (!AGENT_ID.test(agentId)) problems.push(`FUKU_AGENT_ID must look like fuku:agent:0x… (40 hex digits), got ${JSON.stringify(agentId)}`);
  const rawKey = env.FUKU_AGENT_PRIVATE_KEY?.trim() ?? "";
  let agentPrivateKey: Config["agentPrivateKey"] = null;
  if (rawKey) {
    if (rawKey.startsWith("<")) problems.push("FUKU_AGENT_PRIVATE_KEY is still a placeholder: copy the key from mcp/.env, or remove the line (the server reads mcp/.env itself).");
    else if (!PRIVATE_KEY.test(rawKey)) problems.push("FUKU_AGENT_PRIVATE_KEY must be 32 bytes of hex (0x followed by 64 hex digits). Its value is not shown.");
    else agentPrivateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  }
  if (problems.length) throw new ConfigError(problems);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, agentId, agentPrivateKey };
}
