/**
 * Demo data: Ava Chen and her agents. Used by `npm run db:seed` and by the demo sign-in when
 * the demo identity is missing. Idempotent: wipes and recreates the demo identity.
 */
import type { PrismaClient } from "@prisma/client";
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

export { DEMO_IDENTITY_ID };
export { DEMO_API_KEY };

/**
 * Seeded agent ids, v2. The v1 ids carry rehearsal decisions on Monad testnet whose records were lost
 * to demo resets, so no record could ever reveal them; the v2 agents start with a clean on-chain
 * history that `npm run reconcile -- --anchor-seeded` fills with exactly the seeded records.
 */
const demoAgentId = (label: string) => `fuku:agent:${keccak256(stringToHex(`fuku:demo-agent:${label}:v2`)).slice(0, 42)}`;
const TRADING = demoAgentId("trading");
const RESEARCH = demoAgentId("research");
const OPS = demoAgentId("ops");
const REBALANCER = demoAgentId("rebalancer");
/** Moves Cleanverse A-Tokens (aUSDC) under an A-Token passport. */
export const PAYMENTS_AGENT_ID = demoAgentId("payments");
export const TRADING_AGENT_ID = TRADING;

const h = (s: string) => keccak256(stringToHex(s));
const daysAgo = (d: number, hour = 10, minute = 0) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, minute, 0, 0);
  return t;
};
const todayAt = (hour: number, minute: number) => daysAgo(0, hour, minute);

export async function seedDemo(db: PrismaClient) {
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
      id: PAYMENTS_AGENT_ID,
      identityId: identity.id,
      name: "Payments Agent",
      version: "1.0",
      status: "active",
      capabilities: JSON.stringify(["transfer", "read_balances"]),
      description: "Pays verified suppliers in Cleanverse aUSDC from Ava's A-Pass wallet, up to 1,000 a day.",
      registeredTx: h("tx:register:" + PAYMENTS_AGENT_ID),
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
          txHash: h("tx:policy:" + PAYMENTS_AGENT_ID),
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
  const seedId = (label: string) => `seed-v2-${label}-${String((seq[label] = (seq[label] ?? -1) + 1)).padStart(2, "0")}`;
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
    await db.decisionRecord.upsert({
      where: { actionId: a.id },
      create: { actionId: a.id, agentId: a.agentId, proofHash, record },
      update: { agentId: a.agentId, proofHash, record },
    });
    const row = await db.agentAction.create({
      data: {
        id: a.id,
        // Seeded history: none of these actions was executed by Fuku. Not on-chain until
        // `npm run reconcile -- --anchor-seeded` anchors the records.
        status: a.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED",
        receiptMode: "mock",
        anchorStatus: "seeded",
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
        txHash: null,
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
  for (const agentId of [TRADING, RESEARCH, OPS, REBALANCER, PAYMENTS_AGENT_ID]) {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    await db.reputationEvent.createMany({
      data: [
        { agentId, kind: "registration", delta: 40, note: "Agent registered in the Fuku registry", createdAt: agent.createdAt },
        { agentId, kind: "human_verified", delta: 10, note: "Owner completed a passkey ceremony (demo record)", createdAt: agent.createdAt },
      ],
    });
  }

  // ---- Scores (same formula as src/lib/engine/reputation.ts) ----
  for (const agentId of [TRADING, RESEARCH, OPS, REBALANCER, PAYMENTS_AGENT_ID]) {
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
    console.log(`${agent.name}: trust score ${score}`);
  }

  console.log(`Seeded demo identity ${identity.id} (${identity.displayName}). Demo API key: ${DEMO_API_KEY}`);
}

