#!/usr/bin/env node
/**
 * Fuku MCP server (stdio): an AI assistant acts as a Fuku agent. It runs on the user's machine, holds
 * the agent's own key, and sends every action through Fuku, where the owner's passport decides.
 *
 *   node mcp/dist/index.js   with FUKU_BASE_URL, FUKU_API_KEY, FUKU_AGENT_ID and, to execute,
 *                            FUKU_AGENT_PRIVATE_KEY in the environment (see mcp/README.md)
 *
 * stdout is the protocol channel: everything else goes to stderr (stdout-guard is imported first).
 */
import { log } from "./stdout-guard.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { privateKeyToAccount } from "viem/accounts";
import { Fuku } from "@fuku/sdk";
import { ConfigError, loadConfig } from "./config.js";
import { createFukuMcpServer } from "./server.js";

/**
 * mcp/.env (written by `npm run mcp:setup`) is read too, so the agent key need not be copied into the
 * client's config; anything the client's env block sets wins. FUKU_MCP_ENV_FILE points elsewhere.
 */
function loadEnvFile() {
  const file = process.env.FUKU_MCP_ENV_FILE?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (existsSync(file)) {
    process.loadEnvFile(file);
    return file;
  }
  return null;
}

async function main() {
  const envFile = loadEnvFile();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee mcp/README.md for the client configuration.\n`);
      process.exit(2);
    }
    throw err;
  }
  const signer = config.agentPrivateKey ? privateKeyToAccount(config.agentPrivateKey) : null;
  const client = new Fuku({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const server = createFukuMcpServer({ config, client, signer });
  await server.connect(new StdioServerTransport());
  log(
    `ready: agent ${config.agentId} at ${config.baseUrl}, ${signer ? `execute enabled (agent key ${signer.address})` : "read-only (no FUKU_AGENT_PRIVATE_KEY)"}${envFile ? `; read ${envFile}` : ""}`,
  );
}

main().catch((err) => {
  process.stderr.write(`[fuku-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
