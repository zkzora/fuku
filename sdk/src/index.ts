/**
 * @fuku/sdk — the developer surface of Fuku Protocol.
 *
 * Five calls cover identity, registration, permissions and scoring:
 *   createIdentity() · registerAgent() · verifyAgent() · requestPermission() · getTrustScore()
 * plus checkPermission() (dry run) and executeAction() (full workflow).
 *
 * 0.2.0: Cleanverse A-Token payments. `executeAction` / `checkPermission` take `to` and `asset`;
 * results carry `compliance` (the three Cleanverse checks and their complianceRef) and, for a
 * guarded transfer, `transfer`. `verifyAgent` reports `owner.cleanverse`.
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
  humanVerified: boolean;
  authMethod: string;
  walletAddress?: string | null;
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

export interface Receipt {
  txHash: string;
  block: number;
  mode: "live" | "mock";
  explorerUrl: string;
  note?: string;
}

export interface Verification {
  verified: boolean;
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
    /** Last persisted A-Pass read for the owner's wallet. `source: "simulated"` means Fuku's simulator answered. */
    cleanverse?: CleanverseOwner;
  };
  passport?: { active: boolean; version: number; allowed: AllowedRule[]; blocked: string[]; scopeApps: string[]; assets?: string[] } | null;
  trust?: { score: number; level: "High" | "Medium" | "Low" };
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
  evidence: Record<string, unknown>;
}

export interface TrustScore {
  agentId: string;
  score: number;
  level: "High" | "Medium" | "Low";
  breakdown: { key: string; label: string; points: number; detail: string }[];
  counts: { successes: number; violations: number; securityEvents: number };
  explanation: string | null;
  explanationProvider: string | null;
}

export interface ActionRequest {
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  /** Recipient wallet for `transfer`. */
  to?: string | null;
  /** A-Token symbol for `transfer` on an A-Token passport, e.g. "aUSDC". */
  asset?: string | null;
  params?: Record<string, unknown>;
}

export interface PermissionCheck {
  agentId: string;
  allowed: boolean;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  /** Cleanverse / guard sub-code for R7-R10, e.g. "CVI_FROZEN". */
  subCode?: string | null;
  reason: string;
  limitUsdcPerDay?: number;
  remainingUsdc?: number;
  compliance?: Compliance | null;
}

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  to?: string | null;
  asset?: string | null;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  subCode?: string | null;
  reason: string;
  proofHash: string;
  receipt: Receipt;
  /** Set when an A-Token moved through FukuSpendGuard; the same transaction records the decision. */
  transfer?: { txHash: string; explorerUrl: string; mode: "live" | "mock" } | null;
  compliance?: Compliance | null;
  scoreBefore: number;
  scoreAfter: number;
  trustDelta: number;
  explanation: string;
  explanationProvider: string;
  workflow: { step: string; status: "ok" | "blocked" | "skipped"; detail: string; ms: number }[];
  createdAt: string;
}

/** Result of mirroring a kill switch on-chain. `ok: false` means the registries did not follow. */
export interface ChainSync {
  ok: boolean;
  receipts: { op: string; txHash: string; mode: "live" | "mock" }[];
  error?: string;
}

export class FukuError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "FukuError";
    this.status = status;
    this.body = body;
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

  private async request<T>(method: string, path: string, body?: unknown, allowStatus: number[] = []): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok && !allowStatus.includes(res.status)) {
      throw new FukuError(res.status, json?.error ?? res.statusText, json);
    }
    return json as T;
  }

  /** Create an identity for one of your users. Becomes human-verified once they add a passkey in Fuku. */
  createIdentity(input: { displayName: string; walletAddress?: string }) {
    return this.request<{ identity: Identity; receipt: Receipt }>("POST", "/identities", input);
  }

  /** Register an AI agent (ERC-8004 style identity) under the API key owner, or a given owner identity. */
  registerAgent(input: { name: string; version?: string; capabilities: string[]; description?: string; ownerIdentityId?: string }) {
    return this.request<{ agent: Agent; receipt: Receipt }>("POST", "/agents", input);
  }

  /** Who is behind this agent, is that human verified, and what is the agent allowed to do? */
  verifyAgent(agentId: string) {
    return this.request<Verification>("GET", `/agents/${encodeURIComponent(agentId)}`, undefined, [404]);
  }

  /** Attach or replace the agent's permission passport. Owner only. */
  requestPermission(agentId: string, policy: Policy) {
    return this.request<{ agent: Agent; receipt: Receipt }>("PUT", `/agents/${encodeURIComponent(agentId)}/permissions`, policy);
  }

  /** Revoke the passport; the agent is paused, in Fuku and in the on-chain registries. Owner only. */
  revokePermission(agentId: string) {
    return this.request<{ ok: true; score: number; chainSync: ChainSync }>("DELETE", `/agents/${encodeURIComponent(agentId)}/permissions`);
  }

  /** Portable trust score with breakdown and explanation. */
  getTrustScore(agentId: string, opts: { explain?: boolean } = {}) {
    const qs = opts.explain === false ? "?explain=0" : "";
    return this.request<TrustScore>("GET", `/agents/${encodeURIComponent(agentId)}/trust${qs}`);
  }

  /** Dry run: would this action be allowed? Nothing is recorded. */
  checkPermission(agentId: string, action: ActionRequest) {
    return this.request<PermissionCheck>("POST", `/agents/${encodeURIComponent(agentId)}/check`, action);
  }

  /** Full workflow: evaluate → execute or block → anchor proof on Monad → update reputation → explain. */
  executeAction(agentId: string, action: ActionRequest) {
    return this.request<ActionResult>("POST", `/agents/${encodeURIComponent(agentId)}/execute`, action, [403]);
  }
}

export default Fuku;
