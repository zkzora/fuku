/**
 * @fuku/sdk — the developer surface of Fuku Protocol.
 *
 * Identity, registration, permissions and scoring:
 *   createIdentity() · registerAgent() · verifyAgent() · requestPermission() · revokePermission() · getTrustScore()
 * Actions:
 *   checkPermission() (preview: nothing recorded, reserved or signed) · executeAction() (full workflow)
 *   getAction() (lifecycle and evidence) · getMandate() (the owner's on-chain mandate)
 *
 * 0.3.0: execution lifecycle and evidence. `executeAction` takes an idempotency key and returns a
 * lifecycle `status`; receipts say whether they are live, pending, failed or simulated (never a
 * mock in live mode); `verifyAgent` reports a check per claim; errors carry a machine `code`.
 * See README.md for the breaking changes from 0.2.0.
 *
 * Works in Node 18+, browsers and edge runtimes (uses global fetch).
 */

export interface FukuOptions {
  /** API key from the Fuku Developer Console (fk_live_…). */
  apiKey: string;
  /** Base URL of the Fuku deployment, e.g. https://fuku.dev or http://localhost:3001 */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface AllowedRule {
  action: string;
  /** Required for value actions (swap, withdraw, transfer, stake). */
  limitUsdcPerDay?: number;
}

export interface Policy {
  allowed: AllowedRule[];
  blocked?: string[];
  scopeApps?: string[];
  /** Cleanverse A-Token symbols (e.g. ["aUSDC"]). A non-empty list makes this an A-Token passport. */
  assets?: string[];
}

export interface Identity {
  id: string;
  displayName: string;
  /** A passkey ceremony with user verification succeeded. Not a proof of unique personhood. */
  humanVerified: boolean;
  authMethod: string;
  walletAddress?: string | null;
  /** How control of walletAddress was proven: "dynamic", "signature", or null (declared only). */
  walletVerifiedBy?: string | null;
  proofTxHash?: string | null;
}

export interface Agent {
  id: string;
  identityId: string;
  name: string;
  version: string;
  status: "registered" | "active" | "paused" | string;
  capabilities: string[];
  trustScore: number | null;
  registeredTx: string | null;
  policy: (Policy & { version: number; active: boolean; txHash: string | null }) | null;
}

/**
 * confirmed: mined (live). pending: broadcast, receipt not seen yet. failed: nothing anchored
 * (live). simulated: a mock receipt from a mock-chain deployment, with no transaction behind it.
 * awaiting-owner: the identity is owner-controlled; its owner's wallet must send this write
 * (see getOwnerActions), Fuku sent nothing.
 */
export interface Receipt {
  txHash: string | null;
  block: number | null;
  mode: "live" | "mock";
  status: "confirmed" | "pending" | "failed" | "simulated" | "awaiting-owner";
  chainId: number;
  explorerUrl: string | null;
  note?: string;
}

export interface Check {
  ok?: boolean;
  status?: string;
  detail?: string;
  evidence?: string;
  [k: string]: unknown;
}

export interface Verification {
  /**
   * True only when the owner completed a passkey ceremony, the passport is active, and the
   * registries hold the agent with that passport hash and an executable status. A Fuku database
   * record alone never makes it true (in mock mode it is always false).
   */
  verified: boolean;
  checks?: {
    record: Check;
    owner: { passkey: Check; wallet: Check; uniqueHuman: Check };
    credential: Check;
    policy: Check;
    anchoring: Check & { status: "anchored" | "stale" | "not_anchored" | "unreachable" | "mock" };
    executable: Check & { valueActions: boolean };
  };
  agent?: {
    id: string;
    onChainId: string;
    name: string;
    version: string;
    status: string;
    capabilities: string[];
    registeredTx: string | null;
  };
  owner?: {
    id: string;
    onChainId: string;
    displayName: string;
    humanVerified: boolean;
    authMethod: string;
    /** Last persisted A-Pass read for the owner's verified wallet. `source: "simulated"` means Fuku's simulator answered. */
    cleanverse?: CleanverseOwner;
  };
  passport?: { active: boolean; version: number; allowed: AllowedRule[]; blocked: string[]; scopeApps: string[]; assets?: string[] } | null;
  trust?: { score: number; level: "High" | "Medium" | "Low"; scoringVersion?: string; uncertainty?: "high" | "medium" | "low" };
  chain?: "live" | "mock";
  error?: string;
}

export interface CleanverseOwner {
  mode: "live" | "simulated" | "off";
  source: "cleanverse" | "simulated";
  found: boolean;
  status: number | null;
  tier: number | null;
  subTier: number | null;
  expiresAt: number | null;
  checkedAt: string | null;
}

export type ComplianceSubCode =
  | "OK"
  | "CVI_NO_WALLET"
  | "CVI_NOT_FOUND"
  | "CVI_FROZEN"
  | "CVI_EXPIRED"
  | "CVI_RULE_REJECTED"
  | "CVA_NOT_ALLOWED"
  | "PROVIDER_ERROR"
  | "PROVIDER_OFF";

export interface ComplianceLeg {
  ok: boolean;
  subCode: ComplianceSubCode;
  detail: string;
}

/** The Cleanverse checks for a value action on an A-Token passport (R9 asset, R7 owner, R8 counterparty). */
export interface Compliance {
  mode: "live" | "simulated" | "off";
  asset: ComplianceLeg;
  owner: ComplianceLeg;
  counterparty: ComplianceLeg;
  /** keccak256 of the canonical evidence JSON; bound into the proof hash and the on-chain attestation. */
  complianceRef: string;
  /** Returned only to callers who may execute for the agent (the owner or a delegate). */
  evidence: Record<string, unknown> | null;
}

export interface TrustScore {
  agentId: string;
  score: number;
  level: "High" | "Medium" | "Low";
  breakdown: { key: string; label: string; points: number; detail: string; dimension?: string }[];
  scoringVersion?: string;
  dimensions?: { identity: number; policy: number; execution: number; risk: number };
  evidence?: { count: number; firstAt: string | null; observationDays: number };
  uncertainty?: "high" | "medium" | "low";
  counts: { successes: number; violations: number; securityEvents: number };
  explanation: string | null;
  explanationProvider: string | null;
}

export interface ActionRequest {
  action: string;
  /** Required (positive, at most 6 decimals) for value actions. */
  amountUsdc?: number | null;
  /** Required when the passport is scoped to applications. */
  app?: string | null;
  /** Recipient wallet; required for `transfer`. */
  to?: string | null;
  /** A-Token symbol for `transfer` on an A-Token passport, e.g. "aUSDC". */
  asset?: string | null;
  params?: Record<string, unknown>;
}

export interface PermissionCheck {
  agentId: string;
  /** Always true: a check is a preview, never an execution. */
  preview: true;
  allowed: boolean;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  /** Machine-readable cause for R4 and R7-R12, e.g. "CVI_FROZEN" or "APP_REQUIRED". */
  subCode?: string | null;
  reason: string;
  limitUsdcPerDay?: number;
  remainingUsdc?: number;
  compliance?: Compliance | null;
}

/**
 * DENIED: blocked, nothing executed. AUTHORIZED: allowed; Fuku recorded the decision but does not
 * execute this kind of action. SUBMITTED / PENDING: a guarded transfer is on its way. CONFIRMED:
 * executed and mined. FAILED: allowed but execution failed; nothing moved. SIMULATED: mock chain.
 */
export type ExecutionStatus = "DENIED" | "AUTHORIZED" | "SUBMITTED" | "CONFIRMED" | "PENDING" | "FAILED" | "SIMULATED";

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc?: number | null;
  /** Authoritative amount in 6-decimal base units, as a decimal string. */
  amountBaseUnits?: string | null;
  app?: string | null;
  to?: string | null;
  asset?: string | null;
  decision: "ALLOWED" | "BLOCKED";
  status: ExecutionStatus;
  ruleId: string;
  subCode?: string | null;
  reason: string;
  proofHash: string;
  receipt: Receipt;
  /** Set when an A-Token moved (or was attempted) through FukuSpendGuard. */
  transfer?: {
    txHash: string | null;
    explorerUrl: string | null;
    mode: "live" | "mock";
    status: Receipt["status"];
    block: number | null;
    logIndex: number | null;
  } | null;
  compliance?: Compliance | null;
  /** keccak256 of the Travel Rule record for a guarded transfer; fetch it with getTravelRule(). */
  travelRuleRef?: string | null;
  idempotencyKey?: string | null;
  /** True when this is the stored result of an earlier request with the same idempotency key. */
  replayed?: boolean;
  scoreBefore: number;
  scoreAfter: number;
  trustDelta: number;
  explanation: string;
  explanationProvider: string;
  workflow: { step: string; status: "ok" | "blocked" | "skipped"; detail: string; ms: number }[];
  createdAt: string;
}

/** One action's lifecycle and evidence, as returned by getAction(). */
export interface ActionReceipt {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc: number | null;
  amountBaseUnits: string | null;
  to: string | null;
  asset: string | null;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string | null;
  reason: string;
  status: ExecutionStatus;
  proofHash: string;
  complianceRef: string | null;
  travelRuleRef: string | null;
  /** keccak256(action id): the id the registries and the guard use for this action. */
  actionHash: string;
  policyVersion: number | null;
  receipt: {
    mode: string;
    anchorStatus: string | null;
    chainId: number | null;
    txHash: string | null;
    transferTxHash: string | null;
    blockNumber: number | null;
    blockHash: string | null;
    /** Index of the GuardedTransferExecuted log in its block. */
    logIndex: number | null;
  };
  error: { class: string; detail: string | null } | null;
  createdAt: string;
  settledAt: string | null;
}

export interface Mandate {
  guard: string;
  wallet: string;
  token: string;
  dailyCapUsdc: number;
  maxPerTxUsdc: number | null;
  validUntil: number | null;
  restrictPayees: boolean;
  version: number;
  spentTodayUsdc: number;
  active: boolean;
}

export interface OwnerAction {
  op: "registerIdentity" | "registerAgent" | "setPolicy" | "revokePolicy" | "setStatus";
  agentId: string | null;
  description: string;
  tx: { chainId: number; from: string; to: string; data: string; value: "0x0" };
}

export interface OwnerActions {
  custody: "relayer" | "owner";
  wallet: string | null;
  controller: string | null;
  reason: "mock-chain" | "custodial" | "no-wallet" | null;
  actions: OwnerAction[];
}

/**
 * An agent on the canonical ERC-8004 Identity Registry (Monad testnet): the NFT the owner's wallet
 * holds, and the agent's own key as its `agentWallet`. `actions` are the transactions the owner's
 * wallet still has to send (register, then setAgentWallet signed by the agent key).
 */
export interface Erc8004Action {
  op: "erc8004Register" | "erc8004SetAgentWallet";
  description: string;
  tx: { chainId: number; from: string; to: string; data: string; value: "0x0" };
  /** setAgentWallet: unix time after which the agent key's signature is refused; send before it. */
  deadline?: number;
}

export interface Erc8004Status {
  chainId: number;
  registry: string | null;
  /** `eip155:{chainId}:{registry}`, the spec's global registry id. */
  registryId: string | null;
  reason: "mock-chain" | "unsupported-chain" | "no-owner-wallet" | "agent-keys-not-configured" | "owned-elsewhere" | null;
  ownerWallet: string | null;
  agentWallet: string | null;
  agentId: string | null;
  agentURI: string;
  registerTx: string | null;
  walletTx: string | null;
  onChain: { owner: string; agentWallet: string; tokenURI: string } | null;
  complete: boolean;
  actions: Erc8004Action[];
}

/** Result of mirroring a kill switch on-chain. `ok: false` means the registries did not follow. */
export interface ChainSync {
  ok: boolean;
  receipts: { op: string; txHash: string | null; mode: "live" | "mock"; status: string }[];
  error?: string;
}

/** Machine-readable error codes returned by the API. */
export type FukuErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "invalid_request"
  | "bad_request"
  | "not_found"
  | "idempotency_mismatch"
  | "idempotency_in_progress"
  | "idempotency_failed"
  | "chain_write_failed"
  | "internal"
  | string;

export class FukuError extends Error {
  status: number;
  code: FukuErrorCode;
  body: unknown;
  /** Seconds to wait before retrying (429). */
  retryAfter?: number;
  constructor(status: number, message: string, body: unknown, code?: string, retryAfter?: number) {
    super(message);
    this.name = "FukuError";
    this.status = status;
    this.body = body;
    this.code = code ?? (status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : "internal");
    this.retryAfter = retryAfter;
  }
}

export class Fuku {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FukuOptions) {
    if (!opts.apiKey) throw new Error("Fuku: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3001").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** A fresh idempotency key. Reuse it when you retry the same executeAction call. */
  static newIdempotencyKey(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, allowStatus: number[] = [], headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: { error?: string; code?: string } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (!res.ok && !allowStatus.includes(res.status)) {
      const retry = Number(res.headers?.get?.("retry-after"));
      throw new FukuError(res.status, json?.error ?? res.statusText, json, json?.code, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return json as T;
  }

  /**
   * Create an identity for one of your users. It starts unverified (the wallet is a declaration
   * until bound with a signature; passkey verification needs a ceremony in Fuku) and is recorded
   * as managed by your API identity, which lets you register and run agents for it.
   */
  createIdentity(input: { displayName: string; walletAddress?: string }) {
    // Nothing is anchored at creation: an owner who binds a wallet first registers it themselves.
    return this.request<{ identity: Identity; receipt: null }>("POST", "/identities", input);
  }

  /** Start binding a wallet to an identity: sign the returned message with that wallet. */
  walletChallenge(identityId: string, wallet: string) {
    return this.request<{ challengeId: string; message: string; expiresAt: string }>("POST", `/identities/${encodeURIComponent(identityId)}/wallet`, { wallet });
  }

  /** Finish the binding with the wallet's signature over the challenge message. */
  bindWallet(identityId: string, input: { challengeId: string; signature: string }) {
    return this.request<{ identity: { id: string; walletAddress: string; walletVerifiedBy: string } }>("PUT", `/identities/${encodeURIComponent(identityId)}/wallet`, input);
  }

  /**
   * For an owner-controlled identity: the registry writes its owner's wallet still has to send,
   * with prepared calldata (`tx.to`, `tx.data`). Fuku never signs them.
   */
  getOwnerActions(identityId: string) {
    return this.request<OwnerActions>("GET", `/identities/${encodeURIComponent(identityId)}/owner-actions`);
  }

  /** After the owner's wallet mined one of those transactions: Fuku checks it on-chain and records it. */
  confirmOwnerAction(identityId: string, input: { op: OwnerAction["op"]; txHash: string; agentId?: string | null }) {
    return this.request<{ ok: true; op: string; txHash: string; block: number; logIndex: number }>("POST", `/identities/${encodeURIComponent(identityId)}/owner-actions`, input);
  }

  /**
   * The agent on the canonical ERC-8004 Identity Registry, and the owner-wallet transactions still
   * to send. Fetch it right before sending setAgentWallet: the agent key's signature expires within
   * minutes. Needs agents:manage for the agent's owner.
   */
  getErc8004(agentId: string) {
    return this.request<Erc8004Status>("GET", `/agents/${encodeURIComponent(agentId)}/erc8004`);
  }

  /** After the owner's wallet mined one of those transactions: Fuku checks it on-chain and records it. */
  confirmErc8004(agentId: string, input: { op: Erc8004Action["op"]; txHash: string }) {
    return this.request<{ ok: true; op: string; agentId: string; txHash: string }>("POST", `/agents/${encodeURIComponent(agentId)}/erc8004`, input);
  }

  /**
   * Register an agent under your API identity, or under `ownerIdentityId` when you may act for that
   * owner (an identity you created, or a delegation with agents:register). Otherwise 403.
   */
  registerAgent(input: { name: string; version?: string; capabilities: string[]; description?: string; ownerIdentityId?: string }) {
    return this.request<{ agent: Agent; receipt: Receipt }>("POST", "/agents", input);
  }

  /** Who is behind this agent, what evidence backs each claim, and can it act right now? */
  verifyAgent(agentId: string) {
    return this.request<Verification>("GET", `/agents/${encodeURIComponent(agentId)}`, undefined, [404]);
  }

  /** Attach or replace the agent's permission passport (owner, or a delegate with agents:manage). */
  requestPermission(agentId: string, policy: Policy) {
    return this.request<{ agent: Agent; receipt: Receipt }>("PUT", `/agents/${encodeURIComponent(agentId)}/permissions`, policy);
  }

  /**
   * Revoke the passport. Fuku pauses the agent and PermissionRegistry.revokePolicy runs on-chain, so
   * FukuSpendGuard rejects every outstanding attestation (PolicyNotActive).
   */
  revokePermission(agentId: string) {
    return this.request<{ ok: true; score: number; chainSync: ChainSync }>("DELETE", `/agents/${encodeURIComponent(agentId)}/permissions`);
  }

  /** Portable trust score with breakdown, dimensions, evidence and an explanation. */
  getTrustScore(agentId: string, opts: { explain?: boolean } = {}) {
    const qs = opts.explain === false ? "?explain=0" : "";
    return this.request<TrustScore>("GET", `/agents/${encodeURIComponent(agentId)}/trust${qs}`);
  }

  /** Preview: would this action be allowed right now? Nothing is recorded, reserved or signed. */
  checkPermission(agentId: string, action: ActionRequest) {
    return this.request<PermissionCheck>("POST", `/agents/${encodeURIComponent(agentId)}/check`, action);
  }

  /**
   * Full workflow: authorize → evaluate → execute or block → anchor → score → explain. Blocked
   * actions resolve (HTTP 403) rather than throw; a pending transfer resolves with status PENDING
   * (HTTP 202). Pass the same `idempotencyKey` when retrying: the stored result is replayed.
   */
  executeAction(agentId: string, action: ActionRequest, opts: { idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
    return this.request<ActionResult>("POST", `/agents/${encodeURIComponent(agentId)}/execute`, action, [403], headers);
  }

  /** One action's lifecycle status and evidence; pending transfers are reconciled first. */
  getAction(actionId: string) {
    return this.request<ActionReceipt>("GET", `/actions/${encodeURIComponent(actionId)}`);
  }

  /**
   * The Travel Rule record of a guarded transfer: Cleanverse's in live mode, the simulator's
   * (`source: "simulated"`) otherwise. Its canonical-JSON keccak256 equals `travelRuleRef`.
   */
  getTravelRule(actionId: string) {
    return this.request<Record<string, unknown>>("GET", `/actions/${encodeURIComponent(actionId)}/travel-rule`);
  }

  /** The owner's on-chain mandate for this agent (null with a `reason` in mock mode or without a guard). */
  getMandate(agentId: string) {
    return this.request<{ mandate: Mandate | null; wallet: string | null; reason: string | null }>("GET", `/agents/${encodeURIComponent(agentId)}/mandate`);
  }
}

export default Fuku;
