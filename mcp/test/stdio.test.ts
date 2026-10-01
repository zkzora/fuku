/**
 * The built server over real stdio: every byte on stdout must be JSON-RPC, logs go to stderr, and a
 * bad configuration stops it with a message (exit 2) that never contains a private key.
 * Needs `npm run build` first (the package's pretest does it).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AGENT_ID, verification } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../dist/index.js");
const key = generatePrivateKey();
const keyAddress = privateKeyToAccount(key).address;

let fuku: Server;
let baseUrl = "";

before(async () => {
  // A fake Fuku app: just enough of the v1 API for fuku_whoami.
  fuku = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer fk_test") return send(401, { error: "Invalid API key", code: "unauthorized" });
    if (url === `/api/v1/agents/${AGENT_ID}`) return send(200, verification(keyAddress));
    if (url === `/api/v1/agents/${AGENT_ID}/mandate`) return send(200, { mandate: null, wallet: null, reason: "mock-chain", guard: null, token: null, chainId: 31337, agentKey: "0x" });
    return send(404, { error: "not found", code: "not_found" });
  });
  await new Promise<void>((resolve) => fuku.listen(0, "127.0.0.1", resolve));
  const addr = fuku.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => new Promise<void>((resolve) => fuku.close(() => resolve())));

/** Environment without any FUKU_* variable the developer's shell may carry. */
function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FUKU_")) env[k] = v;
  return { ...env, ...extra };
}

function run(env: Record<string, string>, requests: unknown[], waitForIds: number[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (d) => {
      stdout += d;
      const seen = new Set(
        stdout
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l).id;
            } catch {
              return null;
            }
          }),
      );
      if (waitForIds.length && waitForIds.every((id) => seen.has(id))) child.stdin.end();
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    if (!waitForIds.length) child.stdin.end();
  });
}

describe("stdio server", () => {
  it("writes only JSON-RPC to stdout, logs to stderr, and answers fuku_whoami", async () => {
    const out = await run(
      { FUKU_BASE_URL: baseUrl, FUKU_API_KEY: "fk_test", FUKU_AGENT_ID: AGENT_ID, FUKU_AGENT_PRIVATE_KEY: key },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "stdio-test", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fuku_whoami", arguments: {} } },
      ],
      [1, 2, 3],
    );
    const lines = out.stdout.split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, "2.0", `stdout line is JSON-RPC: ${line.slice(0, 80)}`);
    }
    const byId = new Map(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    assert.ok(byId.get(2).result.tools.some((t: { name: string }) => t.name === "fuku_execute_action"));
    const whoami = byId.get(3).result;
    assert.equal(whoami.isError, false);
    assert.match(whoami.content[0].text, /You are MCP Assistant/);
    assert.match(out.stderr, /\[fuku-mcp\] ready: agent fuku:agent:0x/);
    assert.ok(!out.stderr.includes(key.slice(2)), "the key is never logged");
  });

  it("stops on a bad configuration with exit code 2, nothing on stdout and no key in the message", async () => {
    const bad = "c0ffee".repeat(10);
    const out = await run({ FUKU_BASE_URL: "not a url", FUKU_AGENT_PRIVATE_KEY: bad }, [], []);
    assert.equal(out.code, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /FUKU_BASE_URL is not a URL/);
    assert.match(out.stderr, /FUKU_API_KEY is not set/);
    assert.match(out.stderr, /FUKU_AGENT_ID is not set/);
    assert.ok(!out.stderr.includes(bad));
  });
});
