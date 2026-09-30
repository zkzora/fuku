/**
 * @fuku/sdk — the developer surface of Fuku Protocol.
 *
 * Five calls cover identity, registration, permissions and scoring:
 *   createIdentity() · registerAgent() · verifyAgent() · requestPermission() · getTrustScore()
 * plus checkPermission() (dry run) and executeAction() (full workflow).
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
  owner?: { id: string; onChainId: string; displayName: string; humanVerified: boolean; authMethod: string };
  passport?: { active: boolean; version: number; allowed: AllowedRule[]; blocked: string[]; scopeApps: string[] } | null;
  trust?: { score: number; level: "High" | "Medium" | "Low" };
  error?: string;
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
  params?: Record<string, unknown>;
}

export interface PermissionCheck {
  agentId: string;
  allowed: boolean;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  reason: string;
  limitUsdcPerDay?: number;
  remainingUsdc?: number;
}

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  reason: string;
  proofHash: string;
  receipt: Receipt;
  scoreBefore: number;
  scoreAfter: number;
  trustDelta: number;
  explanation: string;
  explanationProvider: string;
  workflow: { step: string; status: "ok" | "blocked" | "skipped"; detail: string; ms: number }[];
  createdAt: string;
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

  /** Revoke the passport; the agent is paused. Owner only. */
  revokePermission(agentId: string) {
    return this.request<{ ok: true; score: number }>("DELETE", `/agents/${encodeURIComponent(agentId)}/permissions`);
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
