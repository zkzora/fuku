/**
 * @fuku/sdk — the developer surface of Fuku Protocol.
 *
 * Identity, registration, permissions and scoring:
 *   createIdentity() · registerAgent() · verifyAgent() · requestPermission() · revokePermission() · getTrustScore()
 * Actions:
 *   checkPermission() (preview: nothing recorded, reserved or signed) · executeAction() (full workflow)
 *   getAction() (lifecycle and evidence) · getMandate() (the owner's on-chain mandate)
 *   verifyScore() (recompute the trust score from the chain, commit-reveal)
 * Keys:
 *   keyInfo() · createAgentKey() · listAgentKeys() · revokeAgentKey() (API keys bound to one agent)
 *
 * 0.4.0: agent-signed execution. An agent that holds its own key signs each executeAction with it
 * (`{ signer }`); Fuku refuses unsigned API executions for such agents. See README.md.
 * 0.5.0: agent keys. Software that runs an agent gets a key bound to that agent and a few scopes,
 * not the owner's key.
 *
 * Works in Node 18+, browsers and edge runtimes (uses global fetch).
 */

export interface FukuOptions {
  /** API key: an owner key from the Developer Console (fk_live_…) or an agent key (fk_agent_…, createAgentKey). */
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

/**
 * Signs agent requests with the agent's own key. A viem LocalAccount (privateKeyToAccount) works as
 * is; the SDK itself has no crypto dependency.
 */
export interface AgentSigner {
  signMessage(args: { message: string }): Promise<string>;
}

/**
 * The message an agent key signs for a request (EIP-191 personal_sign). It carries the exact body, so
 * the signature covers the action, amount, recipient and asset, plus the idempotency key and time.
 */
export function agentRequestMessage(r: { agentId: string; method: string; path: string; idempotencyKey: string; issuedAt: number; body: string }): string {
  return [
    "Fuku agent request",
    `Agent: ${r.agentId}`,
    `Request: ${r.method} ${r.path}`,
    `Idempotency-Key: ${r.idempotencyKey}`,
    `Issued-At: ${r.issuedAt}`,
    `Body: ${r.body}`,
  ].join("\n");
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
    /** The agent's own key (its ERC-8004 agentWallet): held by Fuku, or by the developer ("external"). */
    agentKey?: { address: string; source: "fuku" | "external" } | null;
    /** Its ERC-8004 registration on the canonical Identity Registry, when there is one. */
    erc8004?: { agentId: string; registry: string | null; chainId: number | null } | null;
  };
  owner?: {
    id: string;
    onChainId: string;
    displayName: string;
    humanVerified: boolean;
    authMethod: string;
    /** Who controls the identity on-chain: "relayer" (custodial) or "owner" (the bound wallet); null until decided. */
    custody?: "relayer" | "owner" | null;
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
  /** Set when the request was signed with the agent's own key (executeAction with `signer`). */
  agentSignature?: { signer: string } | null;
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

export interface MandatePayee {
  address: string;
  /** The demo recipient's name when Fuku knows the address. */
  label: string | null;
}

/** Recompute-from-chain (commit-reveal) result, as returned by verifyScore(). */
export interface ScoreVerification {
  agentId: string;
  scoringVersion: string;
  chainId: number;
  events: { source: "rpc" | "envio-hypersync"; fromBlock: number; toBlock: number; complete: boolean; decisions: number; executions: number };
  records: {
    revealed: number;
    verified: number;
    mismatched: { actionId: string; reason: string }[];
    unanchored: string[];
    unrevealed: { actionHash: string; allowed: boolean; ruleId: string; txHash: string }[];
    successes: { transfers: number; legacy: number };
    violations: number;
    firstEvidenceAt: number | null;
  };
  inputs: { key: string; label: string; chain: number | boolean | null; ledger: number | boolean; committed: boolean }[];
  chainScore: number;
  anchored: { score: number; updatedAt: string } | null;
  ledgerScore: number;
  /** ✓: every record checks out, nothing on-chain is unrevealed, and chain, anchored and ledger scores agree. */
  verified: boolean;
  notCommitted: string[];
  notes: string[];
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
  reason: "mock-chain" | "unsupported-chain" | "no-owner-wallet" | "agent-keys-not-configured" | "owned-elsewhere" | "agent-uri-not-public" | null;
  ownerWallet: string | null;
  agentWallet: string | null;
  /** fuku: a key Fuku generated and holds (the demo agents); external: yours, set with setErc8004AgentKey. */
  agentKeySource: "fuku" | "external" | null;
  /**
   * With an external key: the EIP-712 AgentWalletSet your agent key must sign (uint256 values as
   * decimal strings), then pass the signature to prepareErc8004AgentWallet.
   */
  agentWalletTypedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { AgentWalletSet: { name: string; type: string }[] };
    primaryType: "AgentWalletSet";
    message: { agentId: string; newWallet: string; owner: string; deadline: string };
  } | null;
  /** public-url: checked to resolve before registering; data: a self-contained data: URI. */
  agentURIKind: "public-url" | "data";
  agentURIProblem: string | null;
  agentId: string | null;
  agentURI: string;
  registerTx: string | null;
  walletTx: string | null;
  onChain: { owner: string; agentWallet: string; tokenURI: string } | null;
  complete: boolean;
  actions: Erc8004Action[];
}

/** Result of mirroring a kill switch on-chain. `ok: false` means the registries did not follow. */
/** Scopes an agent key can carry (an owner key is not scoped: it acts as the owner everywhere). */
export type AgentKeyScope = "agent:read" | "agent:check" | "agent:execute" | "agent:actions" | "agents:verify";

/** An API key bound to one agent. The raw key is returned once, by createAgentKey. */
export interface AgentKey {
  id: string;
  name: string;
  prefix: string;
  agentId: string;
  scopes: AgentKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the key this client presents may do. */
export interface KeyInfo {
  /** owner: acts as the owner on every route; agent: only its agent, only its scopes; session: the web app. */
  kind: "owner" | "agent" | "session";
  key: { name: string; prefix: string } | null;
  owner: { id: string; displayName: string };
  agentId: string | null;
  scopes: AgentKeyScope[] | null;
  knownScopes: AgentKeyScope[];
}

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
  | "agent_key_forbidden"
  | "agent_key_scope"
  | "agent_key_other_agent"
  | "agent_key_owner_mismatch"
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

  private request<T>(method: string, path: string, body?: unknown, allowStatus: number[] = [], headers: Record<string, string> = {}): Promise<T> {
    return this.send<T>(method, path, body !== undefined ? JSON.stringify(body) : undefined, allowStatus, headers);
  }

  /** `bodyText` is sent byte for byte (an agent signature covers it). */
  private async send<T>(method: string, path: string, bodyText: string | undefined, allowStatus: number[], headers: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(bodyText !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: bodyText,
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

  /**
   * Bring your own agent key: the address of a key you generated and keep. Fuku never sees the key; it
   * drops any key it generated for the agent.
   */
  setErc8004AgentKey(agentId: string, agentKey: string) {
    return this.request<Erc8004Status>("PUT", `/agents/${encodeURIComponent(agentId)}/erc8004`, { agentKey });
  }

  /**
   * Your agent key signed `agentWalletTypedData`: Fuku checks the signature and returns the
   * setAgentWallet transaction for the owner's wallet to send (before `deadline`).
   */
  prepareErc8004AgentWallet(agentId: string, input: { signature: string; deadline: string }) {
    return this.request<{ action: Erc8004Action }>("POST", `/agents/${encodeURIComponent(agentId)}/erc8004`, {
      agentWalletSignature: input.signature,
      deadline: input.deadline,
    });
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
   *
   * `signer`: the agent's own key. Required by Fuku for an agent that holds its own key (set with
   * setErc8004AgentKey); the request is signed over its exact body, idempotency key and issue time.
   * A signed call always carries an idempotency key (a fresh one when you pass none).
   */
  async executeAction(agentId: string, action: ActionRequest, opts: { idempotencyKey?: string; signer?: AgentSigner } = {}) {
    const path = `/agents/${encodeURIComponent(agentId)}/execute`;
    if (!opts.signer) {
      const headers: Record<string, string> = opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {};
      return this.request<ActionResult>("POST", path, action, [403], headers);
    }
    const idempotencyKey = opts.idempotencyKey ?? Fuku.newIdempotencyKey();
    const body = JSON.stringify(action);
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = agentRequestMessage({ agentId, method: "POST", path: `/api/v1/agents/${agentId}/execute`, idempotencyKey, issuedAt, body });
    const signature = await opts.signer.signMessage({ message });
    return this.send<ActionResult>("POST", path, body, [403], {
      "idempotency-key": idempotencyKey,
      "x-fuku-agent-signature": signature,
      "x-fuku-agent-issued-at": String(issuedAt),
    });
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
    return this.request<{
      mandate: Mandate | null;
      wallet: string | null;
      reason: string | null;
      /** What the owner's wallet needs to open a mandate itself. */
      guard: string | null;
      token: string | null;
      chainId: number;
      agentKey: string;
      /** Payees the owner's wallet approved (confirmed with isPayee); null without a mandate. */
      payees?: MandatePayee[] | null;
      /** events: from the guard's PayeeSet events; known-addresses: only addresses Fuku knows were checked. */
      payeesSource?: "events" | "known-addresses" | null;
    }>("GET", `/agents/${encodeURIComponent(agentId)}/mandate`);
  }

  /**
   * "Recompute from chain": each decision record Fuku reveals is checked against the proof anchored
   * for it, and fuku-score/2 is recomputed from what checks out. `verified` is the ✓. Needs the live
   * chain (409 `mock_chain` otherwise).
   */
  verifyScore(agentId: string) {
    return this.request<ScoreVerification>("GET", `/agents/${encodeURIComponent(agentId)}/verify-score`);
  }

  /** What this client's key may do: an owner key, or an agent key with its agent and scopes. */
  keyInfo() {
    return this.request<KeyInfo>("GET", "/key");
  }

  /**
   * Mint an agent key: an API key that acts only as this agent, only with `scopes` (default
   * agent:read, agent:check, agent:execute, agent:actions). It can never change the passport, manage
   * agents or identities, or reach other agents. Give it to the software that runs the agent (the Fuku
   * MCP server) instead of your own key. Owner only; the raw key is returned once.
   */
  createAgentKey(agentId: string, input: { name: string; scopes?: AgentKeyScope[] }) {
    return this.request<{ key: AgentKey; raw: string }>("POST", `/agents/${encodeURIComponent(agentId)}/keys`, input);
  }

  /** The agent keys bound to this agent (owner only). */
  listAgentKeys(agentId: string) {
    return this.request<{ keys: AgentKey[] }>("GET", `/agents/${encodeURIComponent(agentId)}/keys`);
  }

  /** Revoke an agent key; it stops working on the next request (owner only). */
  revokeAgentKey(agentId: string, keyId: string) {
    return this.request<{ ok: true }>("DELETE", `/agents/${encodeURIComponent(agentId)}/keys/${encodeURIComponent(keyId)}`);
  }
}

export default Fuku;
