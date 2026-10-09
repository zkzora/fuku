/** Shared fixtures: a fake @fuku/sdk client with the MCP Assistant's data. */
import type { ActionReceipt, ActionResult, KeyInfo, PermissionCheck, ScoreVerification, Verification } from "@fuku/sdk";
import type { FukuClient } from "../src/server.js";

export const AGENT_ID = "fuku:agent:0x00000000000000000000000000000000000000a1";
export const NUSANTARA = "0x7AD75AD75A52e8d4ee5290294C498917386f40BB";

export const verification = (agentKey: string | null): Verification => ({
  verified: true,
  agent: {
    id: AGENT_ID,
    onChainId: "0x" + "a1".padStart(64, "0"),
    name: "MCP Assistant",
    version: "1.0",
    status: "active",
    capabilities: ["transfer", "read_balances"],
    registeredTx: null,
    agentKey: agentKey ? { address: agentKey, source: "external" } : null,
    erc8004: { agentId: "1961", registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", chainId: 10143 },
  },
  owner: { id: "fuku:id:0x1", onChainId: "0x1", displayName: "Ava Chen", humanVerified: true, authMethod: "passkey", custody: "relayer" },
  passport: {
    active: true,
    version: 1,
    allowed: [{ action: "transfer", limitUsdcPerDay: 100 }, { action: "read_balances" }],
    blocked: ["withdraw", "change_owner"],
    scopeApps: [],
    assets: ["aUSDC"],
  },
  trust: { score: 65, level: "Medium" },
  chain: "live",
});

export const blockedCheck: PermissionCheck = {
  agentId: AGENT_ID,
  preview: true,
  allowed: false,
  decision: "BLOCKED",
  ruleId: "R2",
  subCode: null,
  reason: "Withdraw funds is on the hard block list of this agent's passport.",
};

export const allowedCheck: PermissionCheck = {
  ...blockedCheck,
  allowed: true,
  decision: "ALLOWED",
  ruleId: "R6",
  reason: "Transfer funds of 30 USDC is within the daily limit (70 USDC remaining today).",
  limitUsdcPerDay: 100,
  remainingUsdc: 70,
};

export const blockedResult: ActionResult = {
  id: "act_blocked",
  agentId: AGENT_ID,
  agentName: "MCP Assistant",
  action: "withdraw",
  amountUsdc: 4800,
  decision: "BLOCKED",
  status: "DENIED",
  ruleId: "R2",
  reason: "Withdraw funds is on the hard block list of this agent's passport.",
  proofHash: "0x" + "ab".repeat(32),
  receipt: { txHash: "0x" + "cd".repeat(32), block: 10, mode: "live", status: "confirmed", chainId: 10143, explorerUrl: "https://testnet.monadexplorer.com/tx/0xcdcd" },
  transfer: null,
  compliance: null,
  idempotencyKey: "key-12345678",
  replayed: false,
  agentSignature: { signer: "0x0000000000000000000000000000000000000001" },
  scoreBefore: 65,
  scoreAfter: 61,
  trustDelta: -4,
  explanation: "The passport hard-blocks withdrawals, so Fuku stopped it.",
  explanationProvider: "fuku-rules",
  workflow: [],
  createdAt: new Date(0).toISOString(),
};

export const scoreVerification: ScoreVerification = {
  agentId: AGENT_ID,
  scoringVersion: "fuku-score/2",
  chainId: 10143,
  events: { source: "envio-hypersync", fromBlock: 1, toBlock: 2, complete: true, decisions: 1, executions: 1 },
  records: { revealed: 2, verified: 2, mismatched: [], unanchored: [], unrevealed: [], successes: { transfers: 1, legacy: 0 }, violations: 1, firstEvidenceAt: null },
  inputs: [],
  chainScore: 63,
  anchored: { score: 63, updatedAt: new Date(0).toISOString() },
  ledgerScore: 63,
  verified: true,
  notCommitted: ["security events"],
  notes: [],
};

/** The key an MCP server should run with: an agent key for AGENT_ID. */
export const agentKeyInfo = (agentId = AGENT_ID): KeyInfo => ({
  kind: "agent",
  key: { name: "MCP server", prefix: "fk_agent_abcde" },
  owner: { id: "fuku:id:0x1", displayName: "Ava Chen" },
  agentId,
  scopes: ["agent:read", "agent:check", "agent:execute", "agent:actions"],
  knownScopes: ["agent:read", "agent:check", "agent:execute", "agent:actions", "agents:verify"],
});

export const ownerKeyInfo: KeyInfo = { ...agentKeyInfo(), kind: "owner", key: { name: "Demo key", prefix: "fk_live_demo" }, agentId: null, scopes: null };

export interface Calls {
  execute: { agentId: string; request: unknown; opts: { idempotencyKey?: string; signer?: unknown } }[];
  check: unknown[];
}

/** A fake Fuku client; override any method per test. */
export function fakeClient(agentKey: string | null, over: Partial<FukuClient> = {}, calls: Calls = { execute: [], check: [] }): FukuClient {
  return {
    keyInfo: async () => agentKeyInfo(),
    verifyAgent: async () => verification(agentKey),
    getMandate: async () => ({
      mandate: { guard: "0xguard", wallet: "0xava", token: "0xatoken", dailyCapUsdc: 100, maxPerTxUsdc: 50, validUntil: null, restrictPayees: true, version: 1, spentTodayUsdc: 30, active: true },
      wallet: "0xava",
      reason: null,
      guard: "0xguard",
      token: "0xatoken",
      chainId: 10143,
      agentKey: "0x" + "a1".padStart(64, "0"),
      payees: [{ address: NUSANTARA, label: "Nusantara Supplies" }],
      payeesSource: "events",
    }),
    checkPermission: async (_id, req) => {
      calls.check.push(req);
      return (req as { action: string }).action === "withdraw" ? blockedCheck : allowedCheck;
    },
    executeAction: async (id, request, opts = {}) => {
      calls.execute.push({ agentId: id, request, opts });
      return { ...blockedResult, idempotencyKey: opts.idempotencyKey ?? null };
    },
    getAction: async (id) =>
      ({
        id,
        agentId: AGENT_ID,
        agentName: "MCP Assistant",
        action: "transfer",
        amountUsdc: 30,
        amountBaseUnits: "30000000",
        to: NUSANTARA,
        asset: "aUSDC",
        decision: "ALLOWED",
        ruleId: "R6",
        reason: "ok",
        status: "CONFIRMED",
        proofHash: "0x01",
        complianceRef: null,
        travelRuleRef: null,
        actionHash: "0x02",
        policyVersion: 1,
        receipt: { mode: "live", anchorStatus: "anchored", chainId: 10143, txHash: "0x03", transferTxHash: "0x03", blockNumber: 5, blockHash: null, logIndex: 1 },
        error: null,
        createdAt: new Date(0).toISOString(),
        settledAt: null,
      }) satisfies ActionReceipt,
    verifyScore: async () => scoreVerification,
    ...over,
  };
}
