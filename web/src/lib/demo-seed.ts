/**
 * Demo data: Ava Chen and her agents. Used by `npm run db:seed` and by the demo sign-in when
 * the demo identity is missing. Idempotent: wipes and recreates the demo identity, keeping what the
 * testnet setup recorded about the seeded agents (see DemoAgentState and DecisionRecord.anchor*).
 */
import type { Agent, Policy, PrismaClient } from "@prisma/client";
import { keccak256, stringToHex } from "viem";
import { deriveVaultKey, encryptText, DEMO_VAULT_PASSPHRASE } from "./vault-crypto";
import { hashApiKey } from "./services/identity";
import { computeScore } from "./engine/reputation";
import { labelFor, policyAnchorHash, type PolicyDoc } from "./engine/policy";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_RECIPIENTS, demoOwnerKey, demoOwnerWallet } from "./cleanverse/demo";
import { signWalletBinding } from "./wallet-binding";
import { cleanverseChain } from "./cleanverse/mode";
import { DEMO_API_KEY, DEMO_IDENTITY_ID } from "./demo-mode";
import { recordHash, recordJson } from "./records";
import { chainConfig, chainMode, registryAddresses } from "./chain";

export { DEMO_IDENTITY_ID };
export { DEMO_API_KEY };

/**
 * The seeded agents' ids and seeded action ids derive from a cohort label. The v1 ids carry rehearsal
 * decisions on Monad testnet whose records were lost to demo resets, so no record could ever reveal
 * them; "v2" is the first cohort whose on-chain history `npm run reconcile -- --anchor-seeded` fills
 * with exactly the seeded records. A live action on a cohort's agents (the pitch's climax) stays on
 * the chain after a reset, so `npm run demo:cohort` moves the demo to a fresh cohort instead.
 */
export const DEFAULT_DEMO_COHORT = "v2";
const COHORT_SETTING = "demo.cohort";
export const DEMO_COHORT_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function demoAgentIds(cohort: string) {
  const id = (label: string) => `fuku:agent:${keccak256(stringToHex(`fuku:demo-agent:${label}:${cohort}`)).slice(0, 42)}`;
  return {
    trading: id("trading"),
    research: id("research"),
    ops: id("ops"),
    rebalancer: id("rebalancer"),
    /** Moves Cleanverse A-Tokens (aUSDC) under an A-Token passport. */
    payments: id("payments"),
  };
}

/** The cohort the demo seeds now (DEFAULT_DEMO_COHORT until `npm run demo:cohort` moves it). */
export async function demoCohort(db: PrismaClient): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: COHORT_SETTING } });
  return row?.value ?? DEFAULT_DEMO_COHORT;
}

export async function setDemoCohort(db: PrismaClient, cohort: string): Promise<void> {
  if (!DEMO_COHORT_PATTERN.test(cohort)) throw new Error(`cohort label ${JSON.stringify(cohort)} must match ${DEMO_COHORT_PATTERN}`);
  await db.setting.upsert({ where: { key: COHORT_SETTING }, create: { key: COHORT_SETTING, value: cohort }, update: { value: cohort } });
}

/** The active cohort's agent ids. */
export async function activeDemoAgentIds(db: PrismaClient) {
  return demoAgentIds(await demoCohort(db));
}

/**
 * Agents a demo reset keeps, with their passport, history and score (Setting "demo.keepAgents"): the
 * MCP Assistant (`npm run mcp:setup`) has a key that lives on someone's machine, so the seed could not
 * re-create it. Every other agent registered under Ava (a rehearsal's "Support Agent", say) is removed
 * by a reset as before.
 */
const KEEP_SETTING = "demo.keepAgents";
/** Holds the kept agents while the demo identity is deleted and re-created. */
const HOLDING_IDENTITY_ID = "fuku:id:demo-reset-holding";

export async function keptDemoAgents(db: PrismaClient): Promise<string[]> {
  const row = await db.setting.findUnique({ where: { key: KEEP_SETTING } });
  const ids: unknown = row ? JSON.parse(row.value) : [];
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

export async function keepAgentAcrossDemoResets(db: PrismaClient, agentId: string): Promise<void> {
  const ids = [...new Set([...(await keptDemoAgents(db)), agentId])];
  const value = JSON.stringify(ids);
  await db.setting.upsert({ where: { key: KEEP_SETTING }, create: { key: KEEP_SETTING, value }, update: { value } });
}

/** Move the kept agents (and their actions) out of the demo identity before it is deleted. */
async function parkKeptAgents(db: PrismaClient): Promise<string[]> {
  const wanted = await keptDemoAgents(db);
  if (!wanted.length) return [];
  // Also picks up agents a reset interrupted after parking them.
  const kept = (await db.agent.findMany({ where: { id: { in: wanted }, identityId: { in: [DEMO_IDENTITY_ID, HOLDING_IDENTITY_ID] } }, select: { id: true } })).map((a) => a.id);
  if (!kept.length) return [];
  await db.identity.upsert({ where: { id: HOLDING_IDENTITY_ID }, create: { id: HOLDING_IDENTITY_ID, displayName: "Demo reset holding (temporary)" }, update: {} });
  await db.agent.updateMany({ where: { id: { in: kept } }, data: { identityId: HOLDING_IDENTITY_ID } });
  await db.agentAction.updateMany({ where: { agentId: { in: kept } }, data: { identityId: HOLDING_IDENTITY_ID } });
  return kept;
}

async function unparkKeptAgents(db: PrismaClient, kept: string[]): Promise<void> {
  if (kept.length) {
    await db.agent.updateMany({ where: { id: { in: kept } }, data: { identityId: DEMO_IDENTITY_ID } });
    await db.agentAction.updateMany({ where: { agentId: { in: kept } }, data: { identityId: DEMO_IDENTITY_ID } });
  }
  await db.identity.deleteMany({ where: { id: HOLDING_IDENTITY_ID } });
}

/**
 * Agent columns the testnet setup fills and a demo reset must keep: the agent key (sealed; losing it
 * would orphan the ERC-8004 agentWallet) and the ERC-8004 registration (without it a second
 * registration would mint a duplicate agent NFT).
 */
const CARRIED_AGENT_COLUMNS = [
  "agentWallet",
  "agentKey",
  "erc8004Id",
  "erc8004Registry",
  "erc8004ChainId",
  "erc8004Owner",
  "erc8004Uri",
  "erc8004Tx",
  "erc8004WalletTx",
] as const;
type CarriedColumn = (typeof CARRIED_AGENT_COLUMNS)[number] | "registeredTx" | "registeredMode";
interface DemoCarry {
  agent: Partial<Record<CarriedColumn, string | number>>;
  /** Where the seeded passport (this version and hash) was anchored. */
  policy?: { version: number; policyHash: string; txHash: string; anchorMode: string };
}

function carryOf(agent: Agent & { policy: Policy | null }): DemoCarry {
  const out: DemoCarry = { agent: {} };
  for (const k of CARRIED_AGENT_COLUMNS) if (agent[k] !== null) out.agent[k] = agent[k];
  // The seed writes placeholder hashes marked "mock"; only a real registration or anchor is carried.
  if (agent.registeredTx && agent.registeredMode && agent.registeredMode !== "mock") {
    out.agent.registeredTx = agent.registeredTx;
    out.agent.registeredMode = agent.registeredMode;
  }
  const p = agent.policy;
  if (p?.active && p.txHash && p.policyHash && p.anchorMode && p.anchorMode !== "mock") {
    out.policy = { version: p.version, policyHash: p.policyHash, txHash: p.txHash, anchorMode: p.anchorMode };
  }
  return out;
}

/** Saved before the reset deletes the agents; merged, so a reset interrupted after the delete loses nothing. */
async function saveDemoCarry(db: PrismaClient, agentIds: string[]) {
  const agents = await db.agent.findMany({ where: { id: { in: agentIds } }, include: { policy: true } });
  for (const agent of agents) {
    const prev = await db.demoAgentState.findUnique({ where: { agentId: agent.id } });
    const before: DemoCarry = prev ? JSON.parse(prev.state) : { agent: {} };
    const now = carryOf(agent);
    const merged: DemoCarry = { agent: { ...before.agent, ...now.agent }, policy: now.policy ?? before.policy };
    if (Object.keys(merged.agent).length === 0 && !merged.policy) continue;
    const state = JSON.stringify(merged);
    await db.demoAgentState.upsert({ where: { agentId: agent.id }, create: { agentId: agent.id, state }, update: { state } });
  }
}

async function restoreDemoCarry(db: PrismaClient, agentIds: string[]) {
  const allowed = new Set<string>([...CARRIED_AGENT_COLUMNS, "registeredTx", "registeredMode"]);
  for (const row of await db.demoAgentState.findMany({ where: { agentId: { in: agentIds } } })) {
    const carry = JSON.parse(row.state) as DemoCarry;
    const data = Object.fromEntries(Object.entries(carry.agent ?? {}).filter(([k]) => allowed.has(k)));
    if (Object.keys(data).length) await db.agent.update({ where: { id: row.agentId }, data });
    const p = carry.policy;
    // Only onto the same passport: a seed whose passport changed is not the one that was anchored.
    if (p) await db.policy.updateMany({ where: { agentId: row.agentId, version: p.version, policyHash: p.policyHash }, data: { txHash: p.txHash, anchorMode: p.anchorMode } });
  }
}

/** Where the seeded record was anchored, when that was on the chain and registry this app uses now. */
function currentAnchor(rec: { proofHash: string; anchorTx: string | null; anchorChainId: number | null; anchorRegistry: string | null; anchorBlock: number | null } | null, proofHash: string) {
  if (!rec?.anchorTx || rec.proofHash.toLowerCase() !== proofHash.toLowerCase() || chainMode() !== "live") return null;
  const registry = registryAddresses()?.permissions;
  if (rec.anchorChainId !== chainConfig().id || !registry || rec.anchorRegistry?.toLowerCase() !== registry.toLowerCase()) return null;
  return { txHash: rec.anchorTx, chainId: rec.anchorChainId, block: rec.anchorBlock };
}

const h = (s: string) => keccak256(stringToHex(s));
const daysAgo = (d: number, hour = 10, minute = 0) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, minute, 0, 0);
  return t;
};
const todayAt = (hour: number, minute: number) => daysAgo(0, hour, minute);

export async function seedDemo(db: PrismaClient, opts: { quiet?: boolean } = {}) {
  const cohort = await demoCohort(db);
  const ids = demoAgentIds(cohort);
  const { trading: TRADING, research: RESEARCH, ops: OPS, rebalancer: REBALANCER, payments: PAYMENTS } = ids;
  const cohortIds = Object.values(ids);
  const log = opts.quiet ? () => undefined : (line: string) => console.log(line);
  await saveDemoCarry(db, cohortIds);
  const kept = await parkKeptAgents(db);
  await db.identity.deleteMany({ where: { id: DEMO_IDENTITY_ID } });
  // Ava's wallet is the address of DEMO_OWNER_PRIVATE_KEY when set (the Cleanverse demo owner),
  // otherwise of a public demo key. Either way the seed proves control with a signed binding.
  const ownerWallet = demoOwnerWallet();
  const issuedAt = new Date();
  const binding = await signWalletBinding(privateKeyToAccount(demoOwnerKey().key), {
    identityId: DEMO_IDENTITY_ID,
    nonce: "demo-seed",
    chainId: Number(process.env.FUKU_CHAIN_ID ?? 10143),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
  });

  const identity = await db.identity.create({
    data: {
      id: DEMO_IDENTITY_ID,
      displayName: "Ava Chen",
      humanVerified: true,
      authMethod: "passkey",
      walletAddress: ownerWallet,
      walletVerifiedBy: "signature",
      walletVerifiedAt: issuedAt,
      // The demo stays custodial: Fuku's relayer is its on-chain controller (labelled in the UI).
      chainCustody: "relayer",
      walletProof: JSON.stringify(binding),
      proofHash: h("proof:" + DEMO_IDENTITY_ID),
      // Seeded history uses placeholder hashes, never real transactions: marked mock so every view says so.
      proofTxHash: "0x91af3c2e7d5b4a6f8c0e1d3b5a7f9c2e4d6b8a0f1c3e5d7b9a2f4c6e8d0b2e07",
      proofBlock: 18_204_331,
      proofMode: "mock",
      createdAt: daysAgo(8),
      connectedApps: {
        create: [
          { name: "Monad DEX", scopes: JSON.stringify(["identity", "trust_score"]), status: "active", connectedAt: daysAgo(4) },
          { name: "Notion", scopes: JSON.stringify(["identity", "vault:knowledge"]), status: "active", connectedAt: daysAgo(6) },
        ],
      },
      accessRequests: {
        create: [
          { app: "Nansen", resource: "trust_analytics", status: "pending", createdAt: todayAt(8, 2) },
          { app: "Notion", resource: "vault:knowledge", status: "approved", createdAt: daysAgo(6) },
        ],
      },
      apiKeys: {
        create: { name: "Demo key", prefix: DEMO_API_KEY.slice(0, 12), keyHash: hashApiKey(DEMO_API_KEY) },
      },
      // Display-only passkey record for the demo persona (no private key exists for it).
      passkeys: {
        create: {
          id: "demo-passkey-ava-chen",
          publicKey: new Uint8Array(Buffer.from(h("demo-passkey-public-key").slice(2), "hex")),
          counter: 12,
          deviceType: "multiDevice",
          backedUp: true,
          transports: JSON.stringify(["internal", "hybrid"]),
          label: "Face ID on MacBook Pro",
          createdAt: daysAgo(8),
        },
      },
    },
  });

  // ---- Memory vault (encrypted client-side; seed uses the demo passphrase) ----
  const key = await deriveVaultKey(identity.id, DEMO_VAULT_PASSPHRASE);
  const items: [string, string, string][] = [
    ["preferences", "Trading preferences", "Risk appetite: moderate. Settle in USDC. Avoid tokens under 30 days old. Prefer Monad-native venues."],
    ["preferences", "Communication style", "Short summaries, no jargon. Flag anything that touches more than 5% of the portfolio."],
    ["knowledge", "Portfolio notes", "Core holdings: MON, USDC, ETH. Long-term thesis on Monad throughput. Rebalance target 60/30/10."],
    ["knowledge", "Research sources", "Trusted: Monad docs, Nansen dashboards, protocol governance forums. Ignore anonymous alpha groups."],
    ["workflow", "Weekly rebalance routine", "Every Monday 09:00: read balances → compare with target → propose swaps under 5,000 USDC → wait for approval."],
    ["rules", "Hard rules", "Never withdraw to external wallets. Never change agent ownership. Never exceed 5,000 USDC per day without a human tap."],
  ];
  for (const [category, title, text] of items) {
    const enc = await encryptText(key, text);
    await db.memoryItem.create({
      data: { identityId: identity.id, category, title, ciphertext: enc.ciphertext, iv: enc.iv, sizeBytes: enc.sizeBytes, createdAt: daysAgo(5) },
    });
  }

  // ---- Agents ----
  const tradingPolicy: PolicyDoc = {
    allowed: [
      { action: "swap", limitUsdcPerDay: 5000 },
      { action: "read_balances" },
      { action: "price_feeds" },
    ],
    blocked: ["withdraw", "change_owner", "transfer"],
    scopeApps: ["Monad DEX"],
    assets: [],
  };
  await db.agent.create({
    data: {
      id: TRADING,
      identityId: identity.id,
      name: "Trading Assistant",
      version: "2.1",
      status: "active",
      capabilities: JSON.stringify(["swap", "read_balances", "price_feeds"]),
      description: "Executes swaps on Monad DEX within a daily USDC budget.",
      registeredTx: h("tx:register:" + TRADING),
      registeredMode: "mock",
      createdAt: daysAgo(7),
      policy: {
        create: {
          allowed: JSON.stringify(tradingPolicy.allowed),
          blocked: JSON.stringify(tradingPolicy.blocked),
          scopeApps: JSON.stringify(tradingPolicy.scopeApps),
          version: 2,
          active: true,
          txHash: h("tx:policy:" + TRADING),
          anchorMode: "mock",
          policyHash: policyAnchorHash(tradingPolicy, 2),
        },
      },
    },
  });

  const researchPolicy: PolicyDoc = {
    allowed: [{ action: "read_vault" }, { action: "web_search" }, { action: "summarize" }],
    blocked: ["withdraw", "change_owner", "swap", "transfer"],
    scopeApps: ["Notion"],
    assets: [],
  };
  await db.agent.create({
    data: {
      id: RESEARCH,
      identityId: identity.id,
      name: "Research Agent",
      version: "1.4",
      status: "active",
      capabilities: JSON.stringify(["read_vault", "web_search", "summarize"]),
      description: "Reads the knowledge vault and drafts research summaries into Notion.",
      registeredTx: h("tx:register:" + RESEARCH),
      registeredMode: "mock",
      createdAt: daysAgo(6),
      policy: {
        create: {
          allowed: JSON.stringify(researchPolicy.allowed),
          blocked: JSON.stringify(researchPolicy.blocked),
          scopeApps: JSON.stringify(researchPolicy.scopeApps),
          version: 1,
          active: true,
          txHash: h("tx:policy:" + RESEARCH),
          anchorMode: "mock",
          policyHash: policyAnchorHash(researchPolicy, 1),
        },
      },
    },
  });

  await db.agent.create({
    data: {
      id: OPS,
      identityId: identity.id,
      name: "Ops Scheduler",
      version: "1.0",
      status: "paused",
      capabilities: JSON.stringify(["calendar", "email_draft"]),
      description: "Schedules meetings and drafts follow-up emails.",
      registeredTx: h("tx:register:" + OPS),
      registeredMode: "mock",
      createdAt: daysAgo(1, 17, 5),
    },
  });

  await db.agent.create({
    data: {
      id: REBALANCER,
      identityId: identity.id,
      name: "Portfolio Rebalancer",
      version: "1.0",
      status: "registered",
      capabilities: JSON.stringify(["swap", "read_balances"]),
      description: "Proposes rebalancing swaps toward the target allocation.",
      registeredTx: h("tx:register:" + REBALANCER),
      registeredMode: "mock",
      createdAt: todayAt(7, 30),
    },
  });

  const paymentsPolicy: PolicyDoc = {
    allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }, { action: "read_balances" }],
    blocked: ["withdraw", "change_owner"],
    scopeApps: [],
    assets: ["aUSDC"],
  };
  await db.agent.create({
    data: {
      id: PAYMENTS,
      identityId: identity.id,
      name: "Payments Agent",
      version: "1.0",
      status: "active",
      capabilities: JSON.stringify(["transfer", "read_balances"]),
      description: "Pays verified suppliers in Cleanverse aUSDC from Ava's A-Pass wallet, up to 1,000 a day.",
      registeredTx: h("tx:register:" + PAYMENTS),
      registeredMode: "mock",
      createdAt: daysAgo(2),
      policy: {
        create: {
          allowed: JSON.stringify(paymentsPolicy.allowed),
          blocked: JSON.stringify(paymentsPolicy.blocked),
          scopeApps: JSON.stringify(paymentsPolicy.scopeApps),
          assets: JSON.stringify(paymentsPolicy.assets),
          version: 1,
          active: true,
          txHash: h("tx:policy:" + PAYMENTS),
          anchorMode: "mock",
          policyHash: policyAnchorHash(paymentsPolicy, 1),
        },
      },
    },
  });

  // ---- Cleanverse simulator fixtures ----
  // Read by the simulator in mock-chain mode; in sim-chain mode the contracts are the source of truth
  // and live reads overwrite these rows.
  const chain = cleanverseChain();
  const yearAhead = Math.floor(Date.now() / 1000) + 365 * 86_400;
  const fixtures = [
    { wallet: ownerWallet.toLowerCase(), cvRecordId: "cv-sim-ava-chen", status: 1, tier: 2 },
    ...DEMO_RECIPIENTS.filter((r) => r.apass).map((r) => ({
      wallet: r.address.toLowerCase(),
      cvRecordId: `cv-sim-${r.label}`,
      status: r.apass!.status,
      tier: r.apass!.tier,
    })),
  ];
  for (const f of fixtures) {
    const data = {
      found: true,
      cvRecordId: f.cvRecordId,
      status: f.status,
      tier: f.tier,
      subTier: 0,
      group: null,
      subGroup: null,
      expiresAt: yearAhead,
      countries: JSON.stringify(["ID"]),
      raw: JSON.stringify({ fixture: true }),
      checkedAt: new Date(),
    };
    await db.cleanversePass.upsert({
      where: { chain_wallet_source: { chain, wallet: f.wallet, source: "simulated" } },
      create: { chain, wallet: f.wallet, source: "simulated", ...data },
      update: data,
    });
  }

  // ---- Ledger: actions + reputation events ----
  type Act = {
    id: string;
    agentId: string;
    action: string;
    amountUsdc?: number;
    app?: string;
    decision: "ALLOWED" | "BLOCKED";
    ruleId: string;
    reason: string;
    daysBack: number;
    hour: number;
    minute: number;
  };
  const acts: Act[] = [];
  const seq: Record<string, number> = {};
  const seedId = (label: string) => `seed-${cohort}-${label}-${String((seq[label] = (seq[label] ?? -1) + 1)).padStart(2, "0")}`;
  // Trading Assistant: 14 allowed swaps/reads over the week, one blocked withdraw this morning.
  for (let i = 0; i < 12; i++) {
    acts.push({
      id: seedId("trading"),
      agentId: TRADING,
      action: i % 3 === 0 ? "read_balances" : "swap",
      amountUsdc: i % 3 === 0 ? undefined : 400 + i * 90,
      app: "Monad DEX",
      decision: "ALLOWED",
      ruleId: "R6",
      reason: i % 3 === 0 ? "Read balances is an allowed capability for Monad DEX." : "Swap assets within the daily limit.",
      daysBack: 6 - Math.floor(i / 2),
      hour: 9 + (i % 2) * 3,
      minute: 15 + i,
    });
  }
  acts.push({ id: seedId("trading"), agentId: TRADING, action: "price_feeds", app: "Monad DEX", decision: "ALLOWED", ruleId: "R6", reason: "Price feeds is an allowed capability for Monad DEX.", daysBack: 0, hour: 9, minute: 20 });
  acts.push({ id: seedId("trading"), agentId: TRADING, action: "swap", amountUsdc: 1200, app: "Monad DEX", decision: "ALLOWED", ruleId: "R6", reason: "Swap assets of 1,200 USDC is within the daily limit (3,800 USDC remaining today).", daysBack: 0, hour: 9, minute: 38 });
  acts.push({ id: seedId("trading"), agentId: TRADING, action: "withdraw", amountUsdc: 4800, app: "Monad DEX", decision: "BLOCKED", ruleId: "R2", reason: "Withdraw funds is on the hard block list of this agent's passport.", daysBack: 0, hour: 9, minute: 41 });
  // Research Agent: 10 allowed reads.
  for (let i = 0; i < 10; i++) {
    acts.push({
      id: seedId("research"),
      agentId: RESEARCH,
      action: ["read_vault", "web_search", "summarize"][i % 3],
      app: "Notion",
      decision: "ALLOWED",
      ruleId: "R6",
      reason: "Allowed capability for Notion.",
      daysBack: 5 - Math.floor(i / 2),
      hour: 8 + (i % 2) * 4,
      minute: 12 + i,
    });
  }
  const seededPolicyHash: Record<string, string> = {
    [TRADING]: policyAnchorHash(tradingPolicy, 2),
    [RESEARCH]: policyAnchorHash(researchPolicy, 1),
  };

  for (const a of acts) {
    // The record commits to the day offset and time of day, not to when this seed ran, so every demo
    // reset rebuilds the same records under the same ids: anchored once, they stay verifiable.
    const record = recordJson({
      actionId: a.id,
      agentId: a.agentId,
      action: a.action,
      amountUsdc: a.amountUsdc ?? null,
      app: a.app ?? null,
      decision: a.decision,
      ruleId: a.ruleId,
      subCode: null,
      guardReason: null,
      policyHash: seededPolicyHash[a.agentId] ?? null,
      complianceRef: null,
      at: null,
      seeded: { day: -a.daysBack, time: `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}` },
      // fuku-score/1 counted an allowed decision as a completed action; the record says so.
      outcome: a.decision === "ALLOWED" ? "legacy-success" : null,
    });
    const proofHash = recordHash(record);
    const kept = await db.decisionRecord.findUnique({ where: { actionId: a.id } });
    const anchor = currentAnchor(kept, proofHash);
    const staleAnchor = kept && kept.proofHash.toLowerCase() !== proofHash.toLowerCase();
    await db.decisionRecord.upsert({
      where: { actionId: a.id },
      create: { actionId: a.id, agentId: a.agentId, proofHash, record },
      update: { agentId: a.agentId, proofHash, record, ...(staleAnchor ? { anchorChainId: null, anchorRegistry: null, anchorTx: null, anchorBlock: null } : {}) },
    });
    const row = await db.agentAction.create({
      data: {
        id: a.id,
        // Seeded history: none of these actions was executed by Fuku. Not on-chain until
        // `npm run reconcile -- --anchor-seeded` anchors the records; once it has, a reset rebuilds
        // the row as anchored (the record keeps where).
        status: a.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED",
        receiptMode: anchor ? "live" : "mock",
        anchorStatus: anchor ? "anchored" : "seeded",
        chainId: anchor?.chainId ?? null,
        blockNumber: anchor?.block ?? null,
        amountMicros: a.amountUsdc !== undefined ? BigInt(Math.round(a.amountUsdc * 1e6)) : null,
        policyVersion: 1,
        agentId: a.agentId,
        identityId: identity.id,
        action: a.action,
        amountUsdc: a.amountUsdc ?? null,
        app: a.app ?? null,
        decision: a.decision,
        reason: a.reason,
        ruleId: a.ruleId,
        proofHash,
        txHash: anchor?.txHash ?? null,
        trustDelta: a.decision === "ALLOWED" ? 1 : -4,
        explanation:
          a.decision === "BLOCKED"
            ? "Trading Assistant tried to withdraw 4,800 USDC, which its permission passport hard-blocks (rule R2). Fuku stopped the action before execution and anchored a proof, so nothing left Ava Chen's control. Trust score moved from 100 to 96 (−4)."
            : null,
        createdAt: daysAgo(a.daysBack, a.hour, a.minute),
      },
    });
    await db.reputationEvent.create({
      data: {
        agentId: a.agentId,
        actionId: row.id,
        // Legacy evidence (fuku-score/1 counted allowed decisions as successes); kept so the seeded
        // history scores as it always has. New allowed decisions without execution earn nothing.
        kind: a.decision === "ALLOWED" ? "success" : "violation",
        delta: a.decision === "ALLOWED" ? 1 : -4,
        note: a.decision === "ALLOWED" ? `Allowed: ${labelFor(a.action)}` : `Blocked: ${labelFor(a.action)} (${a.ruleId})`,
        createdAt: daysAgo(a.daysBack, a.hour, a.minute),
      },
    });
  }
  for (const agentId of [TRADING, RESEARCH, OPS, REBALANCER, PAYMENTS]) {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    await db.reputationEvent.createMany({
      data: [
        { agentId, kind: "registration", delta: 40, note: "Agent registered in the Fuku registry", createdAt: agent.createdAt },
        { agentId, kind: "human_verified", delta: 10, note: "Owner completed a passkey ceremony (demo record)", createdAt: agent.createdAt },
      ],
    });
  }

  // ---- Scores (same formula as src/lib/engine/reputation.ts) ----
  for (const agentId of [TRADING, RESEARCH, OPS, REBALANCER, PAYMENTS]) {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, reputationEvents: true } });
    const ev = agent.reputationEvents;
    const score = computeScore({
      passkeyVerified: true,
      // Ava's wallet is bound above and her simulator A-Pass fixture is active (seeded below).
      apassEligible: true,
      hasActivePolicy: Boolean(agent.policy?.active),
      successes: ev.filter((e) => e.kind === "success").length,
      violations: ev.filter((e) => e.kind === "violation").length,
      securityEvents: 0,
    }).score;
    await db.agent.update({ where: { id: agentId }, data: { trustScore: score } });
    log(`${agent.name}: trust score ${score}`);
  }

  await restoreDemoCarry(db, cohortIds);
  await unparkKeptAgents(db, kept);
  log(`Seeded demo identity ${identity.id} (${identity.displayName}), cohort ${cohort}. Demo API key: ${DEMO_API_KEY}`);
  return { cohort, ids };
}

