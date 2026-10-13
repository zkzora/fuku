/**
 * Agent keys over the real v1 route handlers, against a throwaway SQLite database (mock chain, every
 * external key blanked before any app module loads; see services.test.ts). Positive: an agent key
 * reads, checks and executes for its own agent. Negative: passport changes, agent and identity
 * management, ERC-8004 setup, key minting, the vault, other agents and other owners are refused.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const dir = mkdtempSync(path.join(tmpdir(), "fuku-keys-test-"));
const SAFE_ENV: Record<string, string> = {
  DATABASE_URL: `file:${path.join(dir, "test.db").replace(/\\/g, "/")}`,
  FUKU_CHAIN_MODE: "mock",
  DEPLOYER_PRIVATE_KEY: "",
  FUKU_COMPLIANCE_SIGNER_KEY: "",
  FUKU_SPEND_GUARD: "",
  NANSEN_API_KEY: "",
  ENVIO_API_TOKEN: "",
  ENVIO_HYPERRPC_TOKEN: "",
  CLEANVERSE_API_ID: "",
  CLEANVERSE_API_KEY: "",
  CLEANVERSE_MODE: "",
  DEMO_OWNER_PRIVATE_KEY: "",
  FUKU_DEMO_ENABLED: "true",
};
Object.assign(process.env, SAFE_ENV);

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Routes = Record<string, Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>>;

let db: typeof import("../db").db;
let identity: typeof import("./identity");
let agents: typeof import("./agents");
let keys: typeof import("./api-keys");
let seed: typeof import("../demo-seed");
let r: Routes;

before(async () => {
  execSync("npx prisma db push --skip-generate", { cwd: path.resolve(__dirname, "../../.."), env: { ...process.env, ...SAFE_ENV }, stdio: "ignore" });
  db = (await import("../db")).db;
  identity = await import("./identity");
  agents = await import("./agents");
  keys = await import("./api-keys");
  seed = await import("../demo-seed");
  const load = async (p: string) => (await import(`../../app/api/${p}/route`)) as Routes[string];
  r = {
    key: await load("v1/key"),
    agents: await load("v1/agents"),
    agent: await load("v1/agents/[id]"),
    trust: await load("v1/agents/[id]/trust"),
    check: await load("v1/agents/[id]/check"),
    execute: await load("v1/agents/[id]/execute"),
    mandate: await load("v1/agents/[id]/mandate"),
    verifyScore: await load("v1/agents/[id]/verify-score"),
    permissions: await load("v1/agents/[id]/permissions"),
    erc8004: await load("v1/agents/[id]/erc8004"),
    records: await load("v1/agents/[id]/records"),
    agentKeys: await load("v1/agents/[id]/keys"),
    agentKey: await load("v1/agents/[id]/keys/[keyId]"),
    action: await load("v1/actions/[id]"),
    travelRule: await load("v1/actions/[id]/travel-rule"),
    identities: await load("v1/identities"),
    wallet: await load("v1/identities/[id]/wallet"),
    ownerActions: await load("v1/identities/[id]/owner-actions"),
  };
  await seed.seedDemo(db, { quiet: true });
});

after(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  (await import("../rate-limit")).resetRateLimits();
});

const POLICY = { allowed: [{ action: "swap", limitUsdcPerDay: 100 }], blocked: ["withdraw"], scopeApps: [] };

async function owner(name: string) {
  const { identity: id } = await identity.createIdentity({ displayName: name, authMethod: "passkey", humanVerified: true });
  const { raw } = await identity.createApiKey(id.id, "owner key");
  const agent = async (agentName: string) => {
    const { agent: a } = await agents.registerAgent(id, { name: agentName, capabilities: ["swap"] });
    await agents.setAgentPolicy(a.id, POLICY);
    return a;
  };
  return { identity: id, key: raw, agent };
}

function call(route: string, method: "GET" | "POST" | "PUT" | "DELETE", key: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = {}) {
  const handler = r[route][method];
  assert.ok(handler, `${route} has no ${method}`);
  const req = new NextRequest("http://localhost/api/test", {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

async function expectStatus(res: Response, status: number, code?: string) {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, status, `expected ${status}${code ? ` ${code}` : ""}, got ${res.status} ${JSON.stringify(body)}`);
  if (code) assert.equal(body.code, code);
  return body;
}

describe("agent keys: what an agent key may do", () => {
  it("only the agent's owner mints one; it starts with the MCP scopes and is fk_agent_", async () => {
    const ava = await owner("Key owner");
    const agent = await ava.agent("Payments bot");
    const res = await call("agentKeys", "POST", ava.key, { id: agent.id }, { name: "MCP server" });
    const body = (await expectStatus(res, 201)) as unknown as { raw: string; key: { agentId: string; scopes: string[] } };
    assert.match(body.raw, /^fk_agent_/);
    assert.equal(body.key.agentId, agent.id);
    assert.deepEqual(body.key.scopes, ["agent:read", "agent:check", "agent:execute", "agent:actions"]);

    const stranger = await owner("Stranger");
    await expectStatus(await call("agentKeys", "POST", stranger.key, { id: agent.id }, { name: "steal" }), 403, "forbidden");
    // A delegate with every scope still cannot mint one: only the owner.
    const { grantDelegation } = await import("./authz");
    await grantDelegation(ava.identity, { delegateId: stranger.identity.id, scopes: ["agents:register", "agents:manage", "agents:execute"] });
    await expectStatus(await call("agentKeys", "POST", stranger.key, { id: agent.id }, { name: "delegate" }), 403, "forbidden");
    await expectStatus(await call("agentKeys", "POST", ava.key, { id: agent.id }, { name: "bad", scopes: ["agents:manage"] }), 400, "invalid_request");
  });

  it("allows its own agent: key info, verification, trust, mandate, score check, dry run, execute, receipt", async () => {
    const ava = await owner("Positive owner");
    const agent = await ava.agent("Own agent");
    const { raw } = await keys.createAgentApiKey(ava.identity, { agentId: agent.id, name: "mcp" });
    const id = { id: agent.id };

    const info = await expectStatus(await call("key", "GET", raw), 200);
    assert.deepEqual([info.kind, info.agentId], ["agent", agent.id]);
    await expectStatus(await call("agent", "GET", raw, id), 200);
    await expectStatus(await call("trust", "GET", raw, id), 200);
    const mandate = await expectStatus(await call("mandate", "GET", raw, id), 200);
    assert.equal(mandate.reason, "mock-chain");
    // verify-score needs the live chain: past authorization it answers mock_chain, not 403.
    await expectStatus(await call("verifyScore", "GET", raw, id), 409, "mock_chain");
    const check = await expectStatus(await call("check", "POST", raw, id, { action: "swap", amountUsdc: 5 }), 200);
    assert.equal(check.decision, "ALLOWED");

    const done = await expectStatus(await call("execute", "POST", raw, id, { action: "swap", amountUsdc: 5 }, { "idempotency-key": "agent-key-exec-1" }), 200);
    assert.equal(done.decision, "ALLOWED");
    const replay = await expectStatus(await call("execute", "POST", raw, id, { action: "swap", amountUsdc: 5 }, { "idempotency-key": "agent-key-exec-1" }), 200);
    assert.deepEqual([replay.id, replay.replayed], [done.id, true]);
    const blocked = await expectStatus(await call("execute", "POST", raw, id, { action: "withdraw", amountUsdc: 50 }), 403);
    assert.deepEqual([blocked.decision, blocked.ruleId], ["BLOCKED", "R2"]);
    const receipt = await expectStatus(await call("action", "GET", raw, { id: String(done.id) }), 200);
    assert.equal(receipt.agentId, agent.id);
  });

  it("refuses passport changes, agent and identity management, ERC-8004, records, key minting and travel-rule data", async () => {
    const ava = await owner("Negative owner");
    const agent = await ava.agent("Locked agent");
    const { raw } = await keys.createAgentApiKey(ava.identity, { agentId: agent.id, name: "mcp" });
    const id = { id: agent.id };
    const refused: [string, "GET" | "POST" | "PUT" | "DELETE", Record<string, string>, unknown?][] = [
      ["permissions", "PUT", id, { allowed: [{ action: "withdraw", limitUsdcPerDay: 1_000_000 }], blocked: [], scopeApps: [] }],
      ["permissions", "DELETE", id],
      ["agents", "GET", {}],
      ["agents", "POST", {}, { name: "Spawned", capabilities: ["swap"] }],
      ["erc8004", "GET", id],
      ["erc8004", "PUT", id, { agentKey: privateKeyToAccount(generatePrivateKey()).address }],
      ["records", "GET", id],
      ["agentKeys", "GET", id],
      ["agentKeys", "POST", id, { name: "another", scopes: ["agents:verify"] }],
      ["identities", "POST", {}, { displayName: "Sybil" }],
      ["wallet", "POST", { id: ava.identity.id }, { wallet: privateKeyToAccount(generatePrivateKey()).address }],
      ["ownerActions", "GET", { id: ava.identity.id }],
    ];
    for (const [route, method, params, body] of refused) {
      await expectStatus(await call(route, method, raw, params, body), 403, "agent_key_forbidden");
    }
    const policy = await db.policy.findUniqueOrThrow({ where: { agentId: agent.id } });
    assert.deepEqual([policy.version, policy.active, JSON.parse(policy.blocked)], [1, true, ["withdraw"]], "the passport is unchanged");
    assert.equal(await db.agent.count({ where: { identityId: ava.identity.id } }), 1, "no agent was registered");
    assert.equal(await db.apiKey.count({ where: { agentId: agent.id } }), 1, "no key was minted");

    // A self-issued action's travel-rule record is owner data, not the agent's.
    const done = await expectStatus(await call("execute", "POST", raw, id, { action: "swap", amountUsdc: 1 }), 200);
    await expectStatus(await call("travelRule", "GET", raw, { id: String(done.id) }), 403, "agent_key_forbidden");
  });

  it("never reaches the vault or the owner's memory: those routes take a session cookie, never an API key", () => {
    // Session routes need a Next request scope (cookies()), so this is checked on the source; the
    // HTTP behaviour (401 for an agent key) is checked against a running app (docs/SECURITY.md section 11).
    const appApi = path.resolve(__dirname, "../../app/api");
    const routes = (sub: string): string[] =>
      readdirSync(path.join(appApi, sub), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith("route.ts"))
        .map((f) => path.join(appApi, sub, f));
    const sessionOnly = [...routes("memory"), ...routes("dev"), ...routes("delegations")];
    assert.ok(sessionOnly.some((f) => f.includes(`memory${path.sep}vault`)));
    for (const f of sessionOnly) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/withApiKey|presentedApiKey|apiKeyFromRaw|identityFromApiKey/.test(src), `${path.relative(appApi, f)} must not accept API keys`);
    }
  });

  it("exactly these v1 routes admit agent keys (a new opt-in must be added here on purpose)", () => {
    const v1 = path.resolve(__dirname, "../../app/api/v1");
    const optedIn = readdirSync(v1, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith("route.ts") && /agentKey:\s*\{/.test(readFileSync(path.join(v1, f), "utf8")))
      .map((f) => f.split(path.sep).join("/"))
      .sort();
    assert.deepEqual(optedIn, [
      "actions/[id]/route.ts",
      "agents/[id]/check/route.ts",
      "agents/[id]/execute/route.ts",
      "agents/[id]/mandate/route.ts",
      "agents/[id]/route.ts",
      "agents/[id]/trust/route.ts",
      "agents/[id]/verify-score/route.ts",
      "key/route.ts",
    ]);
  });

  it("refuses other agents of the same owner and agents of other owners", async () => {
    const ava = await owner("Two-agent owner");
    const mine = await ava.agent("Mine");
    const sibling = await ava.agent("Sibling");
    const bob = await owner("Bob");
    const bobs = await bob.agent("Bob's agent");
    const { raw } = await keys.createAgentApiKey(ava.identity, { agentId: mine.id, name: "mcp" });

    for (const other of [sibling, bobs]) {
      const id = { id: other.id };
      await expectStatus(await call("agent", "GET", raw, id), 403, "agent_key_other_agent");
      await expectStatus(await call("trust", "GET", raw, id), 403, "agent_key_other_agent");
      await expectStatus(await call("mandate", "GET", raw, id), 403, "agent_key_other_agent");
      await expectStatus(await call("check", "POST", raw, id, { action: "swap", amountUsdc: 1 }), 403, "agent_key_other_agent");
      await expectStatus(await call("execute", "POST", raw, id, { action: "swap", amountUsdc: 1 }), 403, "agent_key_other_agent");
      assert.equal(await db.agentAction.count({ where: { agentId: other.id } }), 0, `nothing executed for ${other.name}`);
    }
    // Their receipts too, even though the owner's own key could read the sibling's.
    const siblingAction = await expectStatus(await call("execute", "POST", ava.key, { id: sibling.id }, { action: "swap", amountUsdc: 1 }), 200);
    await expectStatus(await call("action", "GET", raw, { id: String(siblingAction.id) }), 403, "agent_key_other_agent");
    await expectStatus(await call("action", "GET", ava.key, { id: String(siblingAction.id) }), 200);
  });

  it("agents:verify (opt-in) adds other agents' public verification, nothing else", async () => {
    const ava = await owner("Verifier owner");
    const mine = await ava.agent("Verifier");
    const bobs = await (await owner("Bob 2")).agent("Counterparty");
    const { raw } = await keys.createAgentApiKey(ava.identity, { agentId: mine.id, name: "mcp", scopes: ["agent:read", "agent:check", "agents:verify"] });
    await expectStatus(await call("agent", "GET", raw, { id: bobs.id }), 200);
    await expectStatus(await call("trust", "GET", raw, { id: bobs.id }), 403, "agent_key_other_agent");
    await expectStatus(await call("check", "POST", raw, { id: bobs.id }, { action: "swap", amountUsdc: 1 }), 403, "agent_key_other_agent");
    // This key has no agent:execute: its own agent's executions are refused too.
    await expectStatus(await call("execute", "POST", raw, { id: mine.id }, { action: "swap", amountUsdc: 1 }), 403, "agent_key_scope");
  });

  it("an agent that holds its own key still needs that key's signature: the API key alone cannot execute", async () => {
    const ava = await owner("Signer owner");
    const agent = await ava.agent("Self-keyed");
    await db.agent.update({ where: { id: agent.id }, data: { agentWallet: privateKeyToAccount(generatePrivateKey()).address, agentKey: null } });
    const { raw } = await keys.createAgentApiKey(ava.identity, { agentId: agent.id, name: "mcp" });
    await expectStatus(await call("execute", "POST", raw, { id: agent.id }, { action: "swap", amountUsdc: 1 }, { "idempotency-key": "self-keyed-1" }), 401, "agent_signature_required");
    assert.equal(await db.agentAction.count({ where: { agentId: agent.id } }), 0);
  });

  it("stops working when revoked, when the agent changes owner, and when the agent is deleted", async () => {
    const ava = await owner("Revoking owner");
    const agent = await ava.agent("Revocable");
    const minted = await keys.createAgentApiKey(ava.identity, { agentId: agent.id, name: "mcp" });
    await expectStatus(await call("agentKey", "DELETE", minted.raw, { id: agent.id, keyId: minted.key.id }), 403, "agent_key_forbidden");
    await expectStatus(await call("agentKey", "DELETE", ava.key, { id: agent.id, keyId: minted.key.id }), 200);
    await expectStatus(await call("agent", "GET", minted.raw, { id: agent.id }), 401, "unauthorized");

    const second = await keys.createAgentApiKey(ava.identity, { agentId: agent.id, name: "mcp 2" });
    const bob = await owner("New owner");
    await db.agent.update({ where: { id: agent.id }, data: { identityId: bob.identity.id } });
    await expectStatus(await call("agent", "GET", second.raw, { id: agent.id }), 403, "agent_key_owner_mismatch");
    await db.agent.delete({ where: { id: agent.id } });
    await expectStatus(await call("key", "GET", second.raw), 401, "unauthorized");
  });

  it("an owner key is unchanged: it still reaches every route", async () => {
    const ava = await owner("Owner key owner");
    const agent = await ava.agent("Managed");
    const info = await expectStatus(await call("key", "GET", ava.key), 200);
    assert.deepEqual([info.kind, info.agentId, info.scopes], ["owner", null, null]);
    await expectStatus(await call("permissions", "PUT", ava.key, { id: agent.id }, { ...POLICY, blocked: ["withdraw", "stake"] }), 200);
    await expectStatus(await call("records", "GET", ava.key, { id: agent.id }), 200);
  });

  it("a demo reset keeps the agent key of a kept agent (the MCP Assistant) and drops the rest of Ava's", async () => {
    const ava = await db.identity.findUniqueOrThrow({ where: { id: seed.DEMO_IDENTITY_ID } });
    const { agent: mcp } = await agents.registerAgent(ava, { name: "MCP Assistant", capabilities: ["swap"] });
    await agents.setAgentPolicy(mcp.id, POLICY);
    await seed.keepAgentAcrossDemoResets(db, mcp.id);
    const kept = await keys.createAgentApiKey(ava, { agentId: mcp.id, name: "mcp" });
    const { agent: rehearsal } = await agents.registerAgent(ava, { name: "Rehearsal", capabilities: ["swap"] });
    const dropped = await keys.createAgentApiKey(ava, { agentId: rehearsal.id, name: "rehearsal" });

    await seed.seedDemo(db, { quiet: true });

    const info = await expectStatus(await call("key", "GET", kept.raw), 200);
    assert.deepEqual([info.kind, info.agentId, (info.owner as { id: string }).id], ["agent", mcp.id, seed.DEMO_IDENTITY_ID]);
    await expectStatus(await call("check", "POST", kept.raw, { id: mcp.id }, { action: "swap", amountUsdc: 1 }), 200);
    await expectStatus(await call("key", "GET", dropped.raw), 401, "unauthorized");
  });
});
