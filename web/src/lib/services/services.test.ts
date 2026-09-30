/**
 * Integration tests against a throwaway SQLite database (schema pushed in `before`). The chain is
 * forced to mock mode and every external key is blanked BEFORE any app module loads: Prisma reads
 * web/.env at runtime, and that file may point at Monad testnet with a funded key.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const dir = mkdtempSync(path.join(tmpdir(), "fuku-test-"));
const SAFE_ENV: Record<string, string> = {
  DATABASE_URL: `file:${path.join(dir, "test.db").replace(/\\/g, "/")}`,
  FUKU_CHAIN_MODE: "mock",
  DEPLOYER_PRIVATE_KEY: "",
  FUKU_COMPLIANCE_SIGNER_KEY: "",
  FUKU_SPEND_GUARD: "",
  KIMI_API_KEY: "",
  QWEN_API_KEY: "",
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

type Mods = {
  db: typeof import("../db").db;
  authz: typeof import("./authz");
  budget: typeof import("./budget");
  actions: typeof import("./actions");
  identity: typeof import("./identity");
  agents: typeof import("./agents");
  seed: typeof import("../demo-seed");
  webauthn: typeof import("../webauthn");
  agentsRoute: typeof import("../../app/api/v1/agents/route");
  permissionsRoute: typeof import("../../app/api/v1/agents/[id]/permissions/route");
  executeRoute: typeof import("../../app/api/v1/agents/[id]/execute/route");
  chain: typeof import("../chain");
  policy: typeof import("../engine/policy");
  compliance: typeof import("../cleanverse/compliance");
  demo: typeof import("../cleanverse/demo");
};
let m: Mods;

before(async () => {
  execSync("npx prisma db push --skip-generate", { cwd: path.resolve(__dirname, "../../.."), env: { ...process.env, ...SAFE_ENV }, stdio: "ignore" });
  m = {
    db: (await import("../db")).db,
    authz: await import("./authz"),
    budget: await import("./budget"),
    actions: await import("./actions"),
    identity: await import("./identity"),
    agents: await import("./agents"),
    seed: await import("../demo-seed"),
    webauthn: await import("../webauthn"),
    agentsRoute: await import("../../app/api/v1/agents/route"),
    permissionsRoute: await import("../../app/api/v1/agents/[id]/permissions/route"),
    executeRoute: await import("../../app/api/v1/agents/[id]/execute/route"),
    chain: await import("../chain"),
    policy: await import("../engine/policy"),
    compliance: await import("../cleanverse/compliance"),
    demo: await import("../cleanverse/demo"),
  };
  await m.seed.seedDemo(m.db);
});

after(async () => {
  await m?.db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  (await import("../rate-limit")).resetRateLimits();
});

async function newIdentity(name: string, humanVerified = true) {
  const { identity } = await m.identity.createIdentity({ displayName: name, authMethod: "passkey", humanVerified });
  const { raw } = await m.identity.createApiKey(identity.id, "test");
  return { identity, key: raw };
}

function req(url: string, method: string, key: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

describe("authorization: caller A cannot act for owner B without a delegation", () => {
  it("rejects registering an agent under another owner (403), allows it after a scoped delegation", async () => {
    const a = await newIdentity("App A");
    const b = await newIdentity("Owner B");
    const body = { name: "Hijacker", capabilities: ["swap"], ownerIdentityId: b.identity.id };
    const denied = await m.agentsRoute.POST(req("/api/v1/agents", "POST", a.key, body), ctx({}));
    assert.equal(denied.status, 403);
    assert.equal(await m.db.agent.count({ where: { identityId: b.identity.id } }), 0);

    await m.authz.grantDelegation(b.identity, { delegateId: a.identity.id, scopes: ["agents:manage"] });
    const wrongScope = await m.agentsRoute.POST(req("/api/v1/agents", "POST", a.key, body), ctx({}));
    assert.equal(wrongScope.status, 403, "agents:manage does not grant agents:register");

    const grant = await m.authz.grantDelegation(b.identity, { delegateId: a.identity.id, scopes: ["agents:register"] });
    const ok = await m.agentsRoute.POST(req("/api/v1/agents", "POST", a.key, body), ctx({}));
    assert.equal(ok.status, 201);
    const created = (await ok.json()) as { agent: { id: string; identityId: string } };
    assert.equal(created.agent.identityId, b.identity.id);

    await m.authz.revokeDelegation(b.identity, grant.id);
    const afterRevoke = await m.agentsRoute.POST(req("/api/v1/agents", "POST", a.key, body), ctx({}));
    assert.equal(afterRevoke.status, 403, "a revoked delegation stops working immediately");
  });

  it("rejects changing or executing another owner's agent", async () => {
    const a = await newIdentity("App A2");
    const b = await newIdentity("Owner B2");
    const { agent } = await m.agents.registerAgent(b.identity, { name: "B's agent", capabilities: ["swap"] });
    const put = await m.permissionsRoute.PUT(req(`/api/v1/agents/${agent.id}/permissions`, "PUT", a.key, { allowed: [{ action: "swap", limitUsdcPerDay: 10 }] }), ctx({ id: agent.id }));
    assert.equal(put.status, 403);
    const exec = await m.executeRoute.POST(req(`/api/v1/agents/${agent.id}/execute`, "POST", a.key, { action: "swap", amountUsdc: 1 }), ctx({ id: agent.id }));
    assert.equal(exec.status, 403);
    assert.equal(await m.db.agentAction.count({ where: { agentId: agent.id } }), 0, "nothing was recorded for the forbidden call");
  });

  it("expired delegations do not authorize", async () => {
    const a = await newIdentity("App A3");
    const b = await newIdentity("Owner B3");
    await m.db.delegation.create({
      data: { ownerId: b.identity.id, delegateId: a.identity.id, scopes: JSON.stringify(["agents:register"]), expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await m.authz.canActFor(a.identity.id, b.identity.id, "agents:register")).ok, false);
  });

  it("an invalid API key is 401 and never falls back to a session", async () => {
    const res = await m.agentsRoute.GET(req("/api/v1/agents", "GET", "fk_live_not_a_real_key"), ctx({}));
    assert.equal(res.status, 401);
  });
});

describe("budget: parallel reservations never exceed the limit", () => {
  it("reserves atomically in base units", async () => {
    const { agent } = await m.agents.registerAgent((await newIdentity("Budget owner")).identity, { name: "Budget agent", capabilities: ["swap"] });
    const limit = BigInt(1_000_000_000); // 1,000 USDC
    const amount = BigInt(200_000_000); // 200 USDC
    const results = await Promise.all(Array.from({ length: 10 }, () => m.budget.reserveBudget(agent.id, "swap", amount, limit)));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal(await m.budget.spentMicros(agent.id, "swap"), limit);
    const day = results[0].day;
    await m.budget.releaseBudget(agent.id, "swap", amount, day);
    assert.equal(await m.budget.spentMicros(agent.id, "swap"), limit - amount);
    assert.equal((await m.budget.reserveBudget(agent.id, "swap", amount + BigInt(1), limit)).ok, false, "one base unit over the remainder is refused");
    assert.equal((await m.budget.reserveBudget(agent.id, "swap", amount, limit)).ok, true, "exactly the remainder is allowed");
  });
});

describe("execution: idempotency, lifecycle and reputation", () => {
  async function tradingSetup() {
    const owner = await m.db.identity.findUniqueOrThrow({ where: { id: m.seed.DEMO_IDENTITY_ID } });
    const trading = await m.db.agent.findFirstOrThrow({ where: { name: "Trading Assistant", identityId: owner.id } });
    return { owner, trading };
  }

  it("keeps the demo climax: Trading Assistant starts at 96, withdraw 4,800 is R2 and costs 4", async () => {
    const { owner, trading } = await tradingSetup();
    const r = await m.actions.executeAction({ callerId: owner.id, agentId: trading.id, action: "withdraw", amountUsdc: 4800, app: "Monad DEX" });
    assert.deepEqual([r.decision, r.ruleId, r.status, r.scoreBefore, r.scoreAfter], ["BLOCKED", "R2", "DENIED", 96, 92]);
    assert.equal(r.receipt.mode, "mock");
    assert.equal(r.receipt.status, "simulated");
    assert.equal(r.receipt.explorerUrl, null, "a mock receipt never links to an explorer");
  });

  it("an allowed decision Fuku does not execute is AUTHORIZED and earns no reputation", async () => {
    const { owner, trading } = await tradingSetup();
    const before = await m.db.reputationEvent.count({ where: { agentId: trading.id } });
    const r = await m.actions.executeAction({ callerId: owner.id, agentId: trading.id, action: "read_balances", app: "Monad DEX" });
    assert.deepEqual([r.decision, r.status, r.trustDelta], ["ALLOWED", "AUTHORIZED", 0]);
    const swap = await m.actions.executeAction({ callerId: owner.id, agentId: trading.id, action: "swap", amountUsdc: 10, app: "Monad DEX" });
    assert.deepEqual([swap.decision, swap.status, swap.trustDelta], ["ALLOWED", "AUTHORIZED", 0]);
    assert.equal(await m.db.reputationEvent.count({ where: { agentId: trading.id } }), before, "no events: reads and unexecuted swaps cannot be farmed");
  });

  it("replays a repeated Idempotency-Key instead of executing again, and refuses a different body", async () => {
    const { owner, trading } = await tradingSetup();
    const input = { callerId: owner.id, agentId: trading.id, action: "withdraw", amountUsdc: 1, app: "Monad DEX", idempotencyKey: "idem-key-0001" };
    const first = await m.actions.executeAction(input);
    const events = await m.db.reputationEvent.count({ where: { agentId: trading.id } });
    const second = await m.actions.executeAction(input);
    assert.equal(second.id, first.id);
    assert.equal(second.replayed, true);
    assert.equal(await m.db.agentAction.count({ where: { agentId: trading.id, idempotencyKey: "idem-key-0001" } }), 1);
    assert.equal(await m.db.reputationEvent.count({ where: { agentId: trading.id } }), events, "no second violation");
    await assert.rejects(() => m.actions.executeAction({ ...input, amountUsdc: 2 }), /different request/);
  });

  it("parallel value actions cannot spend the same remainder", async () => {
    const { owner, trading } = await tradingSetup();
    const spent = await m.budget.spentMicros(trading.id, "swap");
    const remaining = Number(BigInt(5_000_000_000) - spent) / 1e6;
    const each = Math.floor((remaining / 2 + 1) * 100) / 100; // two of these do not fit
    const results = await Promise.all([0, 1].map(() => m.actions.executeAction({ callerId: owner.id, agentId: trading.id, action: "swap", amountUsdc: each, app: "Monad DEX" })));
    const allowed = results.filter((r) => r.decision === "ALLOWED");
    assert.equal(allowed.length, 1);
    assert.equal(results.find((r) => r.decision === "BLOCKED")?.ruleId, "R5");
    assert.ok((await m.budget.spentMicros(trading.id, "swap")) <= BigInt(5_000_000_000));
  });

  it("an unverified owner cannot move value through a direct API call (R11), and it is not the agent's fault", async () => {
    const owner = await newIdentity("Unverified owner", false);
    const { agent } = await m.agents.registerAgent(owner.identity, { name: "Unverified agent", capabilities: ["swap"] });
    await m.agents.setAgentPolicy(agent.id, { allowed: [{ action: "swap", limitUsdcPerDay: 100 }], blocked: [], scopeApps: [] });
    const res = await m.executeRoute.POST(req(`/api/v1/agents/${agent.id}/execute`, "POST", owner.key, { action: "swap", amountUsdc: 5 }), ctx({ id: agent.id }));
    const body = (await res.json()) as { ruleId: string; subCode: string };
    assert.equal(res.status, 403);
    assert.deepEqual([body.ruleId, body.subCode], ["R11", "OWNER_UNVERIFIED"]);
    assert.equal(await m.db.reputationEvent.count({ where: { agentId: agent.id, kind: "violation" } }), 0);
  });

  it("an A-Token transfer in mock mode is SIMULATED (nothing moved, no execution credit)", async () => {
    const owner = await m.db.identity.findUniqueOrThrow({ where: { id: m.seed.DEMO_IDENTITY_ID } });
    const r = await m.actions.executeAction({
      callerId: owner.id,
      agentId: m.seed.PAYMENTS_AGENT_ID,
      action: "transfer",
      amountUsdc: 25,
      to: "0x7ad75ad75a52e8d4ee5290294c498917386f40bb",
      asset: "aUSDC",
    });
    assert.deepEqual([r.decision, r.status, r.transfer?.mode, r.trustDelta], ["ALLOWED", "SIMULATED", "mock", 0]);
    assert.equal(r.amountBaseUnits, "25000000");
    // Travel Rule record from the simulator, bound to its reference.
    const { record, ref } = await m.actions.getTravelRule(owner, r.id);
    const tr = record as { source: string; amount: string; beneficiary: { wallet: string; cvRecordId: string | null } };
    assert.equal(tr.source, "simulated");
    assert.equal(tr.amount, "25000000");
    assert.equal(tr.beneficiary.cvRecordId, "cv-sim-nusantara");
    assert.equal(ref, r.travelRuleRef);
    const { travelRuleRefOf } = await import("../cleanverse/travel-rule");
    assert.equal(travelRuleRefOf(record), ref);
  });
});

describe("passport writes are strict", () => {
  it("refuses unknown actions and value actions without a daily limit", async () => {
    const { agent } = await m.agents.registerAgent((await newIdentity("Strict owner")).identity, { name: "Strict agent", capabilities: ["swap"] });
    await assert.rejects(() => m.agents.setAgentPolicy(agent.id, { allowed: [{ action: "swap" }], blocked: [], scopeApps: [] }), /daily limit/);
    await assert.rejects(() => m.agents.setAgentPolicy(agent.id, { allowed: [{ action: "teleport" }], blocked: [], scopeApps: [] }), /Unknown action/);
  });
});

describe("wallet binding", () => {
  it("binds a wallet with a signed, single-use challenge", async () => {
    const { identity } = await newIdentity("Wallet owner");
    const account = privateKeyToAccount(generatePrivateKey());
    const ch = await m.identity.walletChallenge(identity, account.address);
    const signature = await account.signMessage({ message: ch.message });
    const bound = await m.identity.bindWallet(identity, { challengeId: ch.challengeId, signature });
    assert.equal(bound.walletVerifiedBy, "signature");
    assert.equal(bound.walletAddress, account.address.toLowerCase());
    await assert.rejects(() => m.identity.bindWallet(identity, { challengeId: ch.challengeId, signature }), /expired or already used|Challenge expired/);
    const v = await m.identity.verificationOf(bound);
    assert.deepEqual([v.wallet.status, v.wallet.method, v.uniqueHuman.status], ["verified", "signature", "not_established"]);
  });

  it("rejects a signature from another key and a wallet already bound elsewhere", async () => {
    const { identity } = await newIdentity("Wallet owner 2");
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const ch = await m.identity.walletChallenge(identity, account.address);
    const forged = await other.signMessage({ message: ch.message });
    await assert.rejects(() => m.identity.bindWallet(identity, { challengeId: ch.challengeId, signature: forged }), /does not match/);
    const ch2 = await m.identity.walletChallenge(identity, account.address);
    await m.identity.bindWallet(identity, { challengeId: ch2.challengeId, signature: await account.signMessage({ message: ch2.message }) });
    const { identity: thief } = await newIdentity("Thief");
    const ch3 = await m.identity.walletChallenge(thief, account.address);
    const stolen = await account.signMessage({ message: ch3.message });
    await assert.rejects(() => m.identity.bindWallet(thief, { challengeId: ch3.challengeId, signature: stolen }), /another Fuku identity/);
  });
});

describe("WebAuthn challenges", () => {
  it("are consumed exactly once, even under concurrency", async () => {
    const c = await m.webauthn.storeChallenge("abc", "authenticate");
    const results = await Promise.allSettled([m.webauthn.consumeChallenge(c.id, "authenticate"), m.webauthn.consumeChallenge(c.id, "authenticate")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  it("refuse origins outside the allow-list in production", () => {
    const prod = { NODE_ENV: "production", WEBAUTHN_ORIGINS: "https://fuku.example" };
    assert.equal(m.webauthn.originAllowed("https://fuku.example", prod), true);
    assert.equal(m.webauthn.originAllowed("http://localhost:3001", prod), false);
    assert.equal(m.webauthn.originAllowed("https://evil.example", prod), false);
    assert.equal(m.webauthn.originAllowed("http://localhost:3002", { NODE_ENV: "development" }), true);
  });
});

describe("revocation is final (server side)", () => {
  const readOnly = { allowed: [{ action: "read_balances" }], blocked: ["withdraw"], scopeApps: [] };

  it("approving the same rules again anchors a new, version-bound passport hash", async () => {
    const { agent } = await m.agents.registerAgent((await newIdentity("Hash owner")).identity, { name: "Hash agent", capabilities: ["read_balances"] });
    const v1 = await m.agents.setAgentPolicy(agent.id, readOnly);
    await m.agents.revokeAgentPolicy(agent.id);
    const v2 = await m.agents.setAgentPolicy(agent.id, readOnly);
    const doc = { ...readOnly, assets: [] };
    assert.deepEqual([v1.policy.version, v2.policy.version], [1, 2]);
    assert.equal(v1.policy.policyHash, m.policy.policyAnchorHash(doc, 1));
    assert.equal(v2.policy.policyHash, m.policy.policyAnchorHash(doc, 2));
    assert.notEqual(v2.policy.policyHash, v1.policy.policyHash, "attestations issued under v1 cannot match v2 on-chain");
  });

  it("a transfer whose authorization changed after the decision is refused before signing", async () => {
    const { identity } = await newIdentity("Kill switch owner");
    const { agent } = await m.agents.registerAgent(identity, { name: "Kill switch agent", capabilities: ["read_balances"] });
    await m.agents.setAgentPolicy(agent.id, readOnly);
    // The snapshot is loaded fresh each time; the verdict must come from the database, not from it.
    const transfer = async (policyVersion: number) => {
      const row = await m.db.agent.findUniqueOrThrow({ where: { id: agent.id }, include: { identity: true } });
      return m.chain.executeGuardedTransfer({
        agent: m.chain.toAgentRef(row, row.identity),
        actionId: `kill-switch-${policyVersion}-${Math.random()}`,
        policyVersion,
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        token: "0x0000000000000000000000000000000000000003",
        amount: BigInt(1),
        proofHash: `0x${"11".repeat(32)}`,
        complianceRef: `0x${"22".repeat(32)}`,
      });
    };
    assert.equal((await transfer(1)).status, "executed"); // mock chain: nothing moves
    await m.agents.setAgentPolicy(agent.id, readOnly); // v2 replaces v1
    assert.deepEqual(await transfer(1), { status: "rejected", reason: "AUTHORIZATION_CHANGED(passport v2 replaced v1)" });
    await m.agents.revokeAgentPolicy(agent.id); // kill switch: passport revoked, agent paused
    assert.deepEqual(await transfer(2), { status: "rejected", reason: "AUTHORIZATION_CHANGED(agent paused)" });
    await m.db.agent.update({ where: { id: agent.id }, data: { status: "active" } });
    assert.deepEqual(await transfer(2), { status: "rejected", reason: "AUTHORIZATION_CHANGED(passport revoked)" });
  });

  it("an idempotent replay after the kill switch returns the stored result and executes nothing; a new key is refused", async () => {
    const { identity } = await newIdentity("Replay owner");
    const { agent } = await m.agents.registerAgent(identity, { name: "Replay agent", capabilities: ["swap"] });
    await m.agents.setAgentPolicy(agent.id, { allowed: [{ action: "swap", limitUsdcPerDay: 100 }], blocked: [], scopeApps: [] });
    const input = { callerId: identity.id, agentId: agent.id, action: "swap", amountUsdc: 5, idempotencyKey: "kill-switch-replay-1" };
    const first = await m.actions.executeAction(input);
    assert.deepEqual([first.decision, first.status], ["ALLOWED", "AUTHORIZED"]);

    await m.agents.revokeAgentPolicy(agent.id);
    const replay = await m.actions.executeAction(input);
    assert.deepEqual([replay.id, replay.replayed, replay.status], [first.id, true, "AUTHORIZED"]);
    assert.equal(await m.db.agentAction.count({ where: { agentId: agent.id } }), 1, "the replay created and executed nothing");
    const fresh = await m.actions.executeAction({ ...input, idempotencyKey: "kill-switch-replay-2" });
    assert.deepEqual([fresh.decision, fresh.ruleId, fresh.status], ["BLOCKED", "R0", "DENIED"]);
  });

  it("a frozen owner A-Pass blocks an A-Token transfer (R7) even for an agent scored 100", async () => {
    const ava = await m.db.identity.findUniqueOrThrow({ where: { id: m.seed.DEMO_IDENTITY_ID } });
    const { agent } = await m.agents.registerAgent(ava, { name: "Top-scored payments", capabilities: ["transfer"] });
    await m.agents.setAgentPolicy(agent.id, { allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }], blocked: [], scopeApps: [], assets: ["aUSDC"] });
    await m.db.reputationEvent.createMany({ data: Array.from({ length: 14 }, (_, i) => ({ agentId: agent.id, kind: "success", delta: 0, note: `confirmed transfer ${i}` })) });
    assert.equal((await m.agents.refreshScore(agent.id)).score, 100);
    const nusantara = m.demo.DEMO_RECIPIENTS.find((r) => r.label === "nusantara")!.address;
    const transfer = () => m.actions.executeAction({ callerId: ava.id, agentId: agent.id, action: "transfer", amountUsdc: 10, to: nusantara, asset: "aUSDC" });
    assert.equal((await transfer()).decision, "ALLOWED");

    const pass = { wallet: ava.walletAddress!.toLowerCase(), source: "simulated" };
    await m.db.cleanversePass.updateMany({ where: pass, data: { status: 2 } });
    m.compliance.clearOwnerPassCache();
    try {
      const r = await transfer();
      assert.deepEqual([r.decision, r.ruleId, r.subCode, r.status, r.transfer], ["BLOCKED", "R7", "CVI_FROZEN", "DENIED", null]);
      assert.ok(r.scoreBefore >= 90, `score ${r.scoreBefore}: the score is not an input to the decision`);
    } finally {
      await m.db.cleanversePass.updateMany({ where: pass, data: { status: 1 } });
      m.compliance.clearOwnerPassCache();
    }
  });
});

describe("ERC-8004", () => {
  it("is not offered on a mocked chain: no registry, nothing prepared", async () => {
    const ava = await m.db.identity.findUniqueOrThrow({ where: { id: m.seed.DEMO_IDENTITY_ID } });
    const agent = await m.db.agent.findFirstOrThrow({ where: { identityId: ava.id } });
    const { erc8004View } = await import("./erc8004");
    const view = await erc8004View(agent, ava);
    assert.deepEqual([view.reason, view.actions.length, view.complete, view.agentWallet], ["mock-chain", 0, false, null]);
  });
});

describe("memory vault passphrases", () => {
  it("the demo keeps its public passphrase; anyone else must set their own before writing", async () => {
    const vault = await import("./vault");
    const ava = await m.db.identity.findUniqueOrThrow({ where: { id: m.seed.DEMO_IDENTITY_ID } });
    assert.deepEqual(vault.vaultStateOf(ava), { mode: "demo", hasPassphrase: false, check: null });
    await assert.rejects(() => vault.setVaultPassphrase(ava, { check: { ciphertext: "x", iv: "y" }, items: [] }), /demo passphrase/);
    const { identity } = await newIdentity("Vault owner");
    assert.deepEqual(vault.vaultStateOf(identity), { mode: "passphrase", hasPassphrase: false, check: null });
    assert.throws(() => vault.assertVaultWritable(identity), /Set your vault passphrase first/);
  });

  it("moves items from the old shared demo key to the owner's passphrase in one write, and resets on request", async () => {
    const vault = await import("./vault");
    const crypto = await import("../vault-crypto");
    const { identity } = await newIdentity("Legacy vault owner");
    // An item written by an earlier build, under the shared demo passphrase.
    const demoKey = await crypto.deriveVaultKey(identity.id, crypto.DEMO_VAULT_PASSPHRASE);
    const legacy = await crypto.encryptText(demoKey, "Never move more than 5% in one trade.");
    const item = await m.db.memoryItem.create({ data: { identityId: identity.id, category: "rules", title: "Trade size", ...legacy } });

    const mine = await crypto.deriveVaultKey(identity.id, "correct horse battery staple");
    const moved = await crypto.encryptText(mine, await crypto.decryptText(demoKey, item.ciphertext, item.iv));
    const check = await crypto.encryptText(mine, crypto.VAULT_CHECK_PLAINTEXT);
    await assert.rejects(() => vault.setVaultPassphrase(identity, { check, items: [] }), /every vault item/, "leaving an item under the old key is refused");
    const state = await vault.setVaultPassphrase(identity, { check, items: [{ id: item.id, ciphertext: moved.ciphertext, iv: moved.iv }] });
    assert.equal(state.hasPassphrase, true);

    const fresh = await m.db.identity.findUniqueOrThrow({ where: { id: identity.id } });
    const stored = await m.db.memoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(await crypto.decryptText(mine, stored.ciphertext, stored.iv), "Never move more than 5% in one trade.");
    await assert.rejects(() => crypto.decryptText(demoKey, stored.ciphertext, stored.iv), "the public demo key no longer opens it");
    assert.equal(await crypto.vaultKeyMatches(mine, vault.vaultStateOf(fresh).check!), true);
    assert.equal(await crypto.vaultKeyMatches(await crypto.deriveVaultKey(identity.id, "wrong passphrase!"), vault.vaultStateOf(fresh).check!), false);
    vault.assertVaultWritable(fresh);

    assert.deepEqual(await vault.resetVault(fresh), { deleted: 1 });
    const after = await m.db.identity.findUniqueOrThrow({ where: { id: identity.id } });
    assert.equal(vault.vaultStateOf(after).hasPassphrase, false);
  });
});
