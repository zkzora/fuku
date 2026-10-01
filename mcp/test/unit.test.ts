import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FukuError } from "@fuku/sdk";
import { ConfigError, loadConfig, type Config } from "../src/config.js";
import { createFukuMcpServer, type FukuClient } from "../src/server.js";
import { AGENT_ID, NUSANTARA, fakeClient, type Calls } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentKey = privateKeyToAccount(generatePrivateKey());
const config: Config = { baseUrl: "http://localhost:3001", apiKey: "fk_test", agentId: AGENT_ID, agentPrivateKey: null };

async function connect(client: FukuClient, signer: typeof agentKey | null) {
  const server = createFukuMcpServer({ config, client, signer });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: unknown) => (r as TextResult).content.map((c) => c.text).join("\n");

describe("configuration", () => {
  const good = { FUKU_BASE_URL: "http://localhost:3001/", FUKU_API_KEY: "fk_live_x", FUKU_AGENT_ID: AGENT_ID };

  it("accepts a complete configuration and normalises it", () => {
    const key = generatePrivateKey();
    const c = loadConfig({ ...good, FUKU_AGENT_PRIVATE_KEY: key.slice(2) });
    assert.deepEqual([c.baseUrl, c.agentPrivateKey], ["http://localhost:3001", key]);
    assert.equal(loadConfig(good).agentPrivateKey, null, "no key: read-only");
  });

  it("points out a placeholder pasted as a value", () => {
    assert.throws(
      () => loadConfig({ ...good, FUKU_AGENT_PRIVATE_KEY: "<from mcp/.env>" }),
      (err: unknown) => err instanceof ConfigError && /still a placeholder/.test(err.message),
    );
  });

  it("lists every problem at once, and never echoes a private key", () => {
    assert.throws(
      () => loadConfig({}),
      (err: unknown) => err instanceof ConfigError && err.problems.length === 3 && /FUKU_BASE_URL/.test(err.message) && /FUKU_API_KEY/.test(err.message) && /FUKU_AGENT_ID/.test(err.message),
    );
    const secretish = "deadbeef".repeat(7);
    assert.throws(
      () => loadConfig({ ...good, FUKU_AGENT_ID: "agent-1", FUKU_BASE_URL: "ftp://x", FUKU_AGENT_PRIVATE_KEY: secretish }),
      (err: unknown) => err instanceof ConfigError && err.problems.length === 3 && !err.message.includes(secretish),
    );
  });
});

describe("tools", () => {
  it("without an agent key the server is read-only: no execute tool, and whoami says why", async () => {
    const mcp = await connect(fakeClient(agentKey.address), null);
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["fuku_check_permission", "fuku_get_action", "fuku_verify_agent", "fuku_verify_score", "fuku_whoami"]);
    const who = await mcp.callTool({ name: "fuku_whoami", arguments: {} });
    assert.equal(who.isError, false);
    assert.match(textOf(who), /Read-only: FUKU_AGENT_PRIVATE_KEY is not set/);
    assert.equal((who.structuredContent as { execute: { enabled: boolean } }).execute.enabled, false);
  });

  it("whoami returns the agent, owner, passport, mandate (with payees), trust score and execute status", async () => {
    const mcp = await connect(fakeClient(agentKey.address), agentKey);
    assert.ok((await mcp.listTools()).tools.some((t) => t.name === "fuku_execute_action"));
    const text = textOf(await mcp.callTool({ name: "fuku_whoami", arguments: {} }));
    for (const want of ["MCP Assistant", "ERC-8004 agent #1961", "Ava Chen", "transfer (up to 100 USDC a day)", "blocked: withdraw, change_owner", "at most 50 USDC per transfer", "Nusantara Supplies", "Trust score: 65", "Execute: enabled"]) {
      assert.ok(text.includes(want), `whoami mentions ${want}`);
    }
  });

  it("whoami warns when the configured key is not the agent's registered key", async () => {
    const mcp = await connect(fakeClient("0x0000000000000000000000000000000000000002"), agentKey);
    assert.match(textOf(await mcp.callTool({ name: "fuku_whoami", arguments: {} })), /is not this agent's registered key/);
  });

  it("a BLOCKED decision is a normal result (isError false) with the rule id and the reason", async () => {
    const calls: Calls = { execute: [], check: [] };
    const mcp = await connect(fakeClient(agentKey.address, {}, calls), agentKey);
    const check = await mcp.callTool({ name: "fuku_check_permission", arguments: { action: "withdraw", amount: 4800 } });
    assert.equal(check.isError, false);
    assert.match(textOf(check), /BLOCKED by rule R2: Withdraw funds is on the hard block list/);
    assert.deepEqual(calls.check[0], { action: "withdraw", amountUsdc: 4800 });

    const run = await mcp.callTool({ name: "fuku_execute_action", arguments: { action: "withdraw", amount: 4800, to: NUSANTARA } });
    assert.equal(run.isError, false);
    const data = run.structuredContent as { decision: string; ruleId: string; reason: string; proofHash: string };
    assert.deepEqual([data.decision, data.ruleId], ["BLOCKED", "R2"]);
    assert.match(textOf(run), /Withdraw funds is on the hard block list/);
    assert.match(textOf(run), /Do not retry with changed parameters/);
  });

  it("execute signs with the agent key and sends a fresh idempotency key, or the one given to retry", async () => {
    const calls: Calls = { execute: [], check: [] };
    const mcp = await connect(fakeClient(agentKey.address, {}, calls), agentKey);
    await mcp.callTool({ name: "fuku_execute_action", arguments: { action: "transfer", amount: 30, to: NUSANTARA, asset: "aUSDC" } });
    await mcp.callTool({ name: "fuku_execute_action", arguments: { action: "transfer", amount: 30, to: NUSANTARA, asset: "aUSDC", idempotencyKey: "retry-key-0001" } });
    const [first, second] = calls.execute;
    assert.equal(first.opts.signer, agentKey);
    assert.ok((first.opts.idempotencyKey ?? "").length >= 8);
    assert.equal(second.opts.idempotencyKey, "retry-key-0001");
    assert.deepEqual(first.request, { action: "transfer", amountUsdc: 30, to: NUSANTARA, asset: "aUSDC" });
  });

  it("real failures are errors: invalid input, auth, a refused agent signature, and an unreachable app", async () => {
    const mcp = await connect(
      fakeClient(agentKey.address, {
        checkPermission: async () => {
          throw new FukuError(401, "Invalid API key", null, "unauthorized");
        },
        executeAction: async () => {
          throw new FukuError(401, "The request is signed by 0x1, not by MCP Assistant's key.", null, "agent_signature_invalid");
        },
        verifyScore: async () => {
          throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3001") });
        },
      }),
      agentKey,
    );
    const invalid = await mcp.callTool({ name: "fuku_check_permission", arguments: { action: "transfer", amount: -5 } });
    assert.equal(invalid.isError, true);
    const auth = await mcp.callTool({ name: "fuku_check_permission", arguments: { action: "transfer", amount: 5 } });
    assert.equal(auth.isError, true);
    assert.match(textOf(auth), /FUKU_API_KEY was refused/);
    const sig = await mcp.callTool({ name: "fuku_execute_action", arguments: { action: "transfer", amount: 5, to: NUSANTARA, asset: "aUSDC" } });
    assert.equal(sig.isError, true);
    assert.match(textOf(sig), /FUKU_AGENT_PRIVATE_KEY is not the key Fuku has for this agent/);
    const down = await mcp.callTool({ name: "fuku_verify_score", arguments: {} });
    assert.equal(down.isError, true);
    assert.match(textOf(down), /Fuku is not reachable at http:\/\/localhost:3001/);
  });

  it("reads actions, verifies agents and scores", async () => {
    const mcp = await connect(fakeClient(agentKey.address), agentKey);
    assert.match(textOf(await mcp.callTool({ name: "fuku_get_action", arguments: { actionId: "act_1" } })), /Status: CONFIRMED/);
    assert.match(textOf(await mcp.callTool({ name: "fuku_verify_agent", arguments: {} })), /✓ Verified: MCP Assistant/);
    assert.match(textOf(await mcp.callTool({ name: "fuku_verify_score", arguments: {} })), /✓ Verified from the chain: score from chain 63, anchored 63, ledger 63/);
  });

  it("serves the passport resource and the safe-payment prompt", async () => {
    const mcp = await connect(fakeClient(agentKey.address), agentKey);
    const res = await mcp.readResource({ uri: "fuku://agent/passport" });
    const body = JSON.parse((res.contents[0] as { text: string }).text);
    assert.deepEqual(body.passport.blocked, ["withdraw", "change_owner"]);
    const prompt = await mcp.getPrompt({ name: "fuku_safe_payment", arguments: { to: NUSANTARA, amount: "30" } });
    const text = (prompt.messages[0].content as { text: string }).text;
    assert.match(text, /fuku_check_permission/);
    assert.match(text, /If it is BLOCKED, stop/);
  });
});

describe("stdout belongs to the protocol", () => {
  it("no source file writes to stdout (console.log/info/debug or process.stdout)", () => {
    const dir = path.resolve(here, "../src");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      const lines = readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/console\.(log|info|debug)\s*\(|process\.stdout\.write/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
