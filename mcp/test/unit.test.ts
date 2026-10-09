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
import { AGENT_ID, NUSANTARA, agentKeyInfo, fakeClient, ownerKeyInfo, type Calls } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentKey = privateKeyToAccount(generatePrivateKey());
const config: Config = { baseUrl: "http://localhost:3001", apiKey: "fk_test", agentId: AGENT_ID, agentPrivateKey: null, allowOwnerKey: false };

async function connect(client: FukuClient, signer: typeof agentKey | null, cfg: Config = config) {
  const server = createFukuMcpServer({ config: cfg, client, signer });
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
    assert.equal(loadConfig(good).allowOwnerKey, false, "an owner key is refused unless allowed");
    assert.equal(loadConfig({ ...good, FUKU_MCP_ALLOW_OWNER_KEY: "1" }).allowOwnerKey, true);
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
    for (const want of ["MCP Assistant", "ERC-8004 agent #1961", "Ava Chen", "transfer (up to 100 USDC a day)", "blocked: withdraw, change_owner", "at most 50 aUSDC per transfer", "Nusantara Supplies", "Trust score: 65", "Execute: enabled"]) {
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

describe("the API key: an agent key for this agent, never the owner's by default", () => {
  it("acts with an agent key bound to FUKU_AGENT_ID, and whoami says so", async () => {
    const mcp = await connect(fakeClient(agentKey.address), agentKey);
    const who = await mcp.callTool({ name: "fuku_whoami", arguments: {} });
    assert.equal(who.isError, false);
    assert.match(textOf(who), /API key: an agent key for this agent only \(agent:read, agent:check, agent:execute, agent:actions\)/);
    assert.equal((who.structuredContent as { apiKey: { kind: string } }).apiKey.kind, "agent");
  });

  it("refuses a full owner key: no call reaches Fuku but the key check", async () => {
    const calls: Calls = { execute: [], check: [] };
    const mcp = await connect(fakeClient(agentKey.address, { keyInfo: async () => ownerKeyInfo }, calls), agentKey);
    const attempts: [string, Record<string, unknown>][] = [
      ["fuku_whoami", {}],
      ["fuku_check_permission", { action: "transfer", amount: 5 }],
      ["fuku_execute_action", { action: "transfer", amount: 5, to: NUSANTARA }],
    ];
    for (const [name, args] of attempts) {
      const r = await mcp.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(textOf(r), /Refused to act: FUKU_API_KEY is Ava Chen's full owner key/);
      assert.match(textOf(r), /FUKU_MCP_ALLOW_OWNER_KEY=1/);
    }
    assert.deepEqual([calls.check.length, calls.execute.length], [0, 0]);
    await assert.rejects(() => mcp.readResource({ uri: "fuku://agent/passport" }), /full owner key/);
  });

  it("accepts an owner key only when FUKU_MCP_ALLOW_OWNER_KEY is set, and warns in whoami", async () => {
    const mcp = await connect(fakeClient(agentKey.address, { keyInfo: async () => ownerKeyInfo }), agentKey, { ...config, allowOwnerKey: true });
    const who = await mcp.callTool({ name: "fuku_whoami", arguments: {} });
    assert.equal(who.isError, false);
    assert.match(textOf(who), /full owner key \(FUKU_MCP_ALLOW_OWNER_KEY=1\): more authority than this agent needs/);
  });

  it("refuses an agent key bound to another agent", async () => {
    const other = "fuku:agent:0x00000000000000000000000000000000000000b2";
    const mcp = await connect(fakeClient(agentKey.address, { keyInfo: async () => agentKeyInfo(other) }), agentKey);
    const r = await mcp.callTool({ name: "fuku_check_permission", arguments: { action: "transfer", amount: 5 } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), new RegExp(`agent key for ${other}, not for FUKU_AGENT_ID`));
  });

  it("explains Fuku's agent-key refusals: another agent, a missing scope", async () => {
    const own = fakeClient(agentKey.address);
    const mcp = await connect(
      fakeClient(agentKey.address, {
        verifyAgent: async (id) => {
          if (id === AGENT_ID) return own.verifyAgent(id);
          throw new FukuError(403, `This key is an agent key for ${AGENT_ID}: it cannot act on or read ${id}.`, null, "agent_key_other_agent");
        },
        verifyScore: async () => {
          throw new FukuError(403, "This key is an agent key without the agent:read scope.", null, "agent_key_scope");
        },
      }),
      agentKey,
    );
    const other = await mcp.callTool({ name: "fuku_verify_agent", arguments: { agentId: "fuku:agent:0x00000000000000000000000000000000000000b2" } });
    assert.equal(other.isError, true);
    assert.match(textOf(other), /needs the agents:verify scope/);
    assert.match(textOf(await mcp.callTool({ name: "fuku_verify_score", arguments: {} })), /lacks the scope for that call/);
  });

  it("checks the key again after a failed check (the app was down)", async () => {
    let up = false;
    const mcp = await connect(
      fakeClient(agentKey.address, {
        keyInfo: async () => {
          if (!up) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3001") });
          return agentKeyInfo();
        },
      }),
      agentKey,
    );
    assert.match(textOf(await mcp.callTool({ name: "fuku_whoami", arguments: {} })), /Fuku is not reachable/);
    up = true;
    assert.equal((await mcp.callTool({ name: "fuku_whoami", arguments: {} })).isError, false);
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
