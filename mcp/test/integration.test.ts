/**
 * End to end on a live chain (opt-in): the built MCP server, spawned over stdio by the MCP SDK's own
 * client, against a running Fuku app and its node. Run `npm run mcp:setup` for that app first.
 *
 *   FUKU_MCP_INTEGRATION=1 FUKU_MCP_ENV_FILE=<mcp/.env from mcp:setup> MONAD_RPC_URL=<the app's node> \
 *     npm run test:integration -w mcp
 *
 * It moves 30 aUSDC-SIM of the MCP agent's daily budget per run (cap 100 a day), so after three runs
 * in one UTC day the first transfer is refused (R5): `npm run mcp:setup -- --fresh` starts over.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, keccak256, parseAbi, parseEventLogs, stringToHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const enabled = process.env.FUKU_MCP_INTEGRATION === "1";
const envFile = path.resolve(process.env.FUKU_MCP_ENV_FILE?.trim() || path.join(here, "..", ".env"));
const rpc = process.env.MONAD_RPC_URL?.trim() || "http://127.0.0.1:8545";
/** The app's deterministic demo recipients (web/src/lib/cleanverse/demo.ts). */
const demoAddress = (label: string) => privateKeyToAddress(keccak256(stringToHex(`fuku:demo:${label}`)));
const NUSANTARA = demoAddress("nusantara");
const UNVERIFIED = demoAddress("unverified");
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** The guard's real ABI, as deployed (contracts/abi). */
const guardEvents = JSON.parse(readFileSync(path.resolve(here, "../../contracts/abi/FukuSpendGuard.json"), "utf8")) as Abi;

type Result = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

describe("MCP server against a live Fuku (local node)", { skip: !enabled && "set FUKU_MCP_INTEGRATION=1 (needs a running app and node; see the file header)" }, () => {
  let mcp: Client;
  const chain = createPublicClient({ transport: http(rpc) });
  let token: Address;
  let firstTransfer: { id: string; idempotencyKey: string };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await mcp.callTool({ name, arguments: args })) as Result;
  const data = <T>(r: Result) => r.structuredContent as T;
  const balance = (who: Address) => chain.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
  /**
   * A local Hardhat node mines only on demand, so after an idle minute its latest block is old. The
   * guard's attestation lives 60 s from the latest block's time, and the transfer then lands in a
   * block stamped "now": it would expire on the way. Monad produces a block every ~0.4 s.
   */
  const freshBlock = async () => {
    if ((await chain.getChainId()) === 31337) await (chain as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "evm_mine", params: [] });
  };

  before(async () => {
    assert.ok(existsSync(envFile), `${envFile} is missing: run npm run mcp:setup for this app first`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FUKU_")) env[k] = v;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(here, "../dist/index.js")],
      env: { ...env, FUKU_MCP_ENV_FILE: envFile },
      stderr: "pipe",
    });
    mcp = new Client({ name: "fuku-integration", version: "0" });
    await mcp.connect(transport);
  });

  after(async () => {
    await mcp?.close();
  });

  it("1. fuku_whoami returns the MCP agent with execute enabled", async () => {
    const r = await call("fuku_whoami");
    assert.equal(r.isError, false, r.content[0]?.text);
    const who = data<{ agent: { id: string; name: string }; execute: { enabled: boolean; reason: string }; mandate: { token: string; dailyCapUsdc: number; maxPerTxUsdc: number } }>(r);
    const configured = readFileSync(envFile, "utf8").match(/^FUKU_AGENT_ID=(.+)$/m)?.[1]?.trim();
    assert.equal(who.agent.id, configured);
    assert.equal(who.agent.name, "MCP Assistant");
    assert.equal(who.execute.enabled, true);
    assert.match(who.execute.reason, /registered key/);
    assert.deepEqual([who.mandate.dailyCapUsdc, who.mandate.maxPerTxUsdc], [100, 50]);
    assert.equal((who as unknown as { apiKey: { kind: string } }).apiKey.kind, "agent", "the server runs with an agent key, not the owner's");
    token = who.mandate.token as Address;
  });

  it("2. fuku_check_permission: 30 to Nusantara allowed, 30 to an unverified wallet R8, withdraw 4,800 R2", async () => {
    const ok = data<{ decision: string; ruleId: string }>(await call("fuku_check_permission", { action: "transfer", amount: 30, to: NUSANTARA, asset: "aUSDC" }));
    assert.deepEqual([ok.decision, ok.ruleId], ["ALLOWED", "R6"]);
    const r8 = await call("fuku_check_permission", { action: "transfer", amount: 30, to: UNVERIFIED, asset: "aUSDC" });
    assert.equal(r8.isError, false);
    assert.deepEqual([data<{ decision: string }>(r8).decision, data<{ ruleId: string }>(r8).ruleId], ["BLOCKED", "R8"]);
    const r2 = data<{ decision: string; ruleId: string }>(await call("fuku_check_permission", { action: "withdraw", amount: 4800 }));
    assert.deepEqual([r2.decision, r2.ruleId], ["BLOCKED", "R2"]);
  });

  it("3. fuku_execute_action pays 30 aUSDC to Nusantara; the chain shows it, checked independently", async () => {
    await freshBlock();
    const before = await balance(NUSANTARA);
    const r = await call("fuku_execute_action", { action: "transfer", amount: 30, to: NUSANTARA, asset: "aUSDC" });
    assert.equal(r.isError, false, r.content[0]?.text);
    const res = data<{ id: string; decision: string; status: string; idempotencyKey: string; transfer: { txHash: Hex } | null; agentSignature: { signer: string } | null }>(r);
    assert.deepEqual([res.decision, res.status], ["ALLOWED", "CONFIRMED"]);
    assert.ok(res.agentSignature?.signer, "Fuku checked the agent key's signature");
    assert.equal((await balance(NUSANTARA)) - before, BigInt(30_000_000), "Nusantara received exactly 30 aUSDC-SIM");
    const receipt = await chain.getTransactionReceipt({ hash: res.transfer!.txHash });
    const [moved] = parseEventLogs({ abi: guardEvents, eventName: "GuardedTransferExecuted", logs: receipt.logs }) as unknown as { args: { to: string; amount: bigint } }[];
    assert.ok(moved, "the transfer transaction carries GuardedTransferExecuted");
    assert.equal(moved.args.to.toLowerCase(), NUSANTARA.toLowerCase());
    assert.equal(moved.args.amount, BigInt(30_000_000));
    firstTransfer = { id: res.id, idempotencyKey: res.idempotencyKey };
  });

  it("4. fuku_execute_action withdraw 4,800 is BLOCKED R2, not an error, and its proof is anchored", async () => {
    const r = await call("fuku_execute_action", { action: "withdraw", amount: 4800, to: NUSANTARA });
    assert.equal(r.isError, false);
    const res = data<{ decision: string; ruleId: string; status: string; proofHash: string; receipt: { txHash: string | null; status: string } }>(r);
    assert.deepEqual([res.decision, res.ruleId, res.status], ["BLOCKED", "R2", "DENIED"]);
    assert.match(res.proofHash, /^0x[0-9a-f]{64}$/);
    assert.equal(res.receipt.status, "confirmed");
    assert.ok(res.receipt.txHash);
    assert.match(r.content[0].text, /BLOCKED by rule R2/);
  });

  it("5. fuku_execute_action transfer 60 is blocked by a limit (the guard's 50 per transfer, or R5)", async (t) => {
    await freshBlock();
    const before = await balance(NUSANTARA);
    const r = await call("fuku_execute_action", { action: "transfer", amount: 60, to: NUSANTARA, asset: "aUSDC" });
    assert.equal(r.isError, false, r.content[0]?.text);
    const res = data<{ decision: string; ruleId: string; subCode: string | null; reason: string }>(r);
    assert.equal(res.decision, "BLOCKED");
    assert.ok(["R10", "R5"].includes(res.ruleId), `${res.ruleId}: ${res.reason}`);
    t.diagnostic(`transfer 60 blocked by ${res.ruleId}${res.subCode ? ` (${res.subCode})` : ""}: ${res.reason}`);
    assert.equal(await balance(NUSANTARA), before, "nothing moved");
  });

  it("6. replaying the same idempotency key returns the same action and moves nothing again", async () => {
    const before = await balance(NUSANTARA);
    const r = await call("fuku_execute_action", { action: "transfer", amount: 30, to: NUSANTARA, asset: "aUSDC", idempotencyKey: firstTransfer.idempotencyKey });
    const res = data<{ id: string; replayed: boolean }>(r);
    assert.deepEqual([res.id, res.replayed], [firstTransfer.id, true]);
    assert.equal(await balance(NUSANTARA), before, "no second transfer");
  });

  it("7. the MCP server's API key (an agent key) cannot change the passport, register agents or reach other agents", async () => {
    const env = readFileSync(envFile, "utf8");
    const value = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
    const [baseUrl, apiKey, agentId] = [value("FUKU_BASE_URL"), value("FUKU_API_KEY"), value("FUKU_AGENT_ID")];
    assert.match(apiKey, /^fk_agent_/, "mcp:setup wrote an agent key, not the owner's");
    const http = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}/api/v1${p}`, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return [res.status, ((await res.json()) as { code?: string }).code];
    };
    const id = encodeURIComponent(agentId);
    assert.deepEqual(await http("PUT", `/agents/${id}/permissions`, { allowed: [{ action: "withdraw", limitUsdcPerDay: 1_000_000 }], blocked: [], scopeApps: [] }), [403, "agent_key_forbidden"]);
    assert.deepEqual(await http("DELETE", `/agents/${id}/permissions`), [403, "agent_key_forbidden"]);
    assert.deepEqual(await http("POST", "/agents", { name: "Spawned", capabilities: ["transfer"] }), [403, "agent_key_forbidden"]);
    assert.deepEqual(await http("POST", `/agents/${id}/keys`, { name: "more" }), [403, "agent_key_forbidden"]);
    const other = encodeURIComponent("fuku:agent:0x0000000000000000000000000000000000000001");
    assert.deepEqual(await http("POST", `/agents/${other}/check`, { action: "transfer", amountUsdc: 1 }), [403, "agent_key_other_agent"]);
    const [status] = await http("GET", `/agents/${id}`);
    assert.equal(status, 200, "its own agent is readable");
  });
});
