import type { Agent, Identity, Policy, ReputationEvent } from "@prisma/client";
import { db } from "../db";
import { apassEligibleFor } from "./cleanverse";
import { newAgentId, hashJson } from "../ids";
import { parsePolicy, policyHashDoc, writablePolicySchema, type PolicyDoc } from "../engine/policy";
import { utcDayStart } from "../engine/permission";
import { computeScore, type ScoreResult } from "../engine/reputation";
import { anchorStateOf, ChainWriteError, registerAgentOnChain, revokePolicyOnChain, setAgentStatusOnChain, setPolicyOnChain, toAgentRef, type ChainReceipt } from "../chain";

export type AgentRow = Agent & { policy: Policy | null };

export interface AgentView {
  id: string;
  identityId: string;
  name: string;
  version: string;
  status: string;
  description: string | null;
  capabilities: string[];
  trustScore: number | null;
  registeredTx: string | null;
  createdAt: string;
  policy: (PolicyDoc & { version: number; active: boolean; txHash: string | null; updatedAt: string }) | null;
}

export function toAgentView(a: AgentRow): AgentView {
  const doc = parsePolicy(a.policy);
  return {
    id: a.id,
    identityId: a.identityId,
    name: a.name,
    version: a.version,
    status: a.status,
    description: a.description,
    capabilities: JSON.parse(a.capabilities),
    trustScore: a.trustScore,
    registeredTx: a.registeredTx,
    createdAt: a.createdAt.toISOString(),
    policy:
      doc && a.policy
        ? {
            ...doc,
            version: a.policy.version,
            active: a.policy.active,
            txHash: a.policy.txHash,
            updatedAt: a.policy.updatedAt.toISOString(),
          }
        : null,
  };
}

type ScoredEvent = Pick<ReputationEvent, "kind"> & { createdAt?: Date };

const EVIDENCE_KINDS = new Set(["success", "violation", "security"]);

export function countEvents(events: ScoredEvent[]) {
  return {
    successes: events.filter((e) => e.kind === "success").length,
    violations: events.filter((e) => e.kind === "violation").length,
    securityEvents: events.filter((e) => e.kind === "security").length,
  };
}

/** Reputation events with the fields the score needs. */
export const SCORED_EVENTS = { select: { kind: true, createdAt: true } } as const;

/**
 * The agent's score. `apassEligible` comes from `apassEligibleFor(owner)` (a persisted read, no
 * provider call); it is a required argument so no caller silently drops the identity signal.
 */
export function scoreFor(agent: AgentRow, identity: Identity, events: ScoredEvent[], signals: { apassEligible: boolean }): ScoreResult {
  const evidence = events.filter((e) => EVIDENCE_KINDS.has(e.kind) && e.createdAt).map((e) => e.createdAt!.getTime());
  return computeScore({
    passkeyVerified: identity.humanVerified,
    apassEligible: signals.apassEligible,
    hasActivePolicy: Boolean(agent.policy?.active),
    ...countEvents(events),
    firstEvidenceAt: evidence.length ? new Date(Math.min(...evidence)) : null,
  });
}

/** Score an agent from the database (loads owner, passport, events and the A-Pass signal). */
export async function scoreAgent(agentId: string): Promise<ScoreResult> {
  const agent = await db.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { policy: true, identity: true, reputationEvents: SCORED_EVENTS },
  });
  return scoreFor(agent, agent.identity, agent.reputationEvents, { apassEligible: await apassEligibleFor(agent.identity) });
}

/** Recompute and persist an agent's trust score from its ledger. */
export async function refreshScore(agentId: string): Promise<ScoreResult> {
  const result = await scoreAgent(agentId);
  await db.agent.update({ where: { id: agentId }, data: { trustScore: result.score } });
  return result;
}

export async function listAgents(identityId: string): Promise<AgentView[]> {
  const rows = await db.agent.findMany({
    where: { identityId },
    include: { policy: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toAgentView);
}

export async function registerAgent(
  identity: Identity,
  input: { name: string; version?: string; capabilities: string[]; description?: string },
) {
  const id = newAgentId();
  const receipt = await registerAgentOnChain({
    id,
    identity: { id: identity.id, humanVerified: identity.humanVerified, proofHash: identity.proofHash },
    name: input.name,
    version: input.version ?? "1.0",
    capabilities: input.capabilities,
  });
  const agent = await db.agent.create({
    data: {
      id,
      identityId: identity.id,
      name: input.name,
      version: input.version ?? "1.0",
      status: "registered",
      capabilities: JSON.stringify(input.capabilities),
      description: input.description,
      registeredTx: receipt.txHash,
      registeredMode: anchorStateOf(receipt),
      reputationEvents: {
        create: [
          { kind: "registration", delta: 40, note: "Agent registered in the Fuku registry" },
          ...(identity.humanVerified
            ? [{ kind: "human_verified", delta: 10, note: "Owner completed a passkey ceremony with user verification" }]
            : []),
        ],
      },
    },
    include: { policy: true },
  });
  const score = await refreshScore(agent.id);
  return { agent: toAgentView({ ...agent, trustScore: score.score }), receipt };
}

export async function setAgentPolicy(agentId: string, raw: unknown) {
  const doc = writablePolicySchema.parse(raw);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const existing = agent.policy;
  const version = (existing?.version ?? 0) + 1;
  const hashDoc = policyHashDoc(doc);
  const receipt = await setPolicyOnChain(toAgentRef(agent, agent.identity), hashDoc, version);
  const data = {
    allowed: JSON.stringify(doc.allowed),
    blocked: JSON.stringify(doc.blocked),
    scopeApps: JSON.stringify(doc.scopeApps),
    assets: JSON.stringify(doc.assets),
    version,
    active: true,
    txHash: receipt.txHash,
    anchorMode: anchorStateOf(receipt),
    policyHash: hashJson(hashDoc),
  };
  const policy = existing
    ? await db.policy.update({ where: { agentId }, data })
    : await db.policy.create({ data: { agentId, ...data } });
  // Attaching a passport activates a freshly registered agent.
  await db.agent.updateMany({ where: { id: agentId, status: "registered" }, data: { status: "active" } });
  const score = await refreshScore(agentId);
  return { policy, receipt, score };
}

/** Result of pushing a kill-switch change on-chain. `ok: false` is surfaced to the caller. */
export interface ChainSync {
  ok: boolean;
  receipts: { op: string; txHash: string | null; mode: string; status: string }[];
  error?: string;
}

async function syncOnChain(tasks: { op: string; run: () => Promise<ChainReceipt | null> }[]): Promise<ChainSync> {
  const receipts: ChainSync["receipts"] = [];
  for (const t of tasks) {
    try {
      const r = await t.run();
      if (r) receipts.push({ op: t.op, txHash: r.txHash, mode: r.mode, status: r.status });
    } catch (err) {
      return { ok: false, receipts, error: err instanceof ChainWriteError ? err.message : (err as Error).message };
    }
  }
  return { ok: true, receipts };
}

/**
 * Kill switch: revoke the passport (the agent is also paused in Fuku). The database changes first
 * (fail safe: Fuku stops allowing the agent immediately), then PermissionRegistry.revokePolicy, so
 * FukuSpendGuard rejects every outstanding attestation with PolicyNotActive. The on-chain agent
 * status is left to the explicit pause / resume switch (AgentRegistry.setStatus), so the two
 * switches stay distinguishable on-chain.
 */
export async function revokeAgentPolicy(agentId: string) {
  await db.policy.updateMany({ where: { agentId }, data: { active: false } });
  await db.agent.update({ where: { id: agentId }, data: { status: "paused" } });
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const ref = toAgentRef(agent, agent.identity);
  const chainSync = await syncOnChain([{ op: "revokePolicy", run: () => revokePolicyOnChain(ref) }]);
  return { score: await refreshScore(agentId), chainSync };
}

export async function setAgentStatus(agentId: string, status: "active" | "paused") {
  await db.agent.update({ where: { id: agentId }, data: { status } });
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const chainSync = await syncOnChain([{ op: `setStatus(${status})`, run: () => setAgentStatusOnChain(toAgentRef(agent, agent.identity), status) }]);
  return { score: await refreshScore(agentId), chainSync };
}

/** Allowed USDC volume for `action` since the start of the current UTC day (matches FukuSpendGuard). */
export async function spentTodayUsdc(agentId: string, action: string) {
  const start = utcDayStart();
  const agg = await db.agentAction.aggregate({
    where: { agentId, action, decision: "ALLOWED", createdAt: { gte: start } },
    _sum: { amountUsdc: true },
  });
  return agg._sum.amountUsdc ?? 0;
}
