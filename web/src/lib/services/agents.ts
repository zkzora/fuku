import type { Agent, Identity, Policy, ReputationEvent } from "@prisma/client";
import { db } from "../db";
import { apassEligibleFor } from "./cleanverse";
import { custodyFor } from "../custody";
import { newAgentId } from "../ids";
import { isATokenPassport, parsePolicy, policyAnchorHash, writablePolicySchema, type PolicyDoc } from "../engine/policy";
import { utcDayStart } from "../engine/permission";
import { computeScore, type ScoreResult } from "../engine/reputation";
import {
  anchorStateOf,
  bumpValidAfterOnChain,
  ChainWriteError,
  registerAgentOnChain,
  revokePolicyOnChain,
  setAgentStatusOnChain,
  setPolicyOnChain,
  toAgentRef,
  type AgentRef,
  type ChainReceipt,
} from "../chain";

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
    identity: {
      id: identity.id,
      humanVerified: identity.humanVerified,
      proofHash: identity.proofHash,
      // Owner-controlled identities are registered by their owner's wallet, never by the relayer.
      custody: custodyFor(identity),
      wallet: identity.walletVerifiedBy ? identity.walletAddress : null,
    },
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

/**
 * Approve a new passport version. The database is written first and the chain follows it: the relayer
 * anchors only the passport the database holds when it has the signer lease (see chain
 * currentPassport), so a concurrent write can neither revive an older version nor race this one. The
 * anchored hash commits to the version (policyAnchorHash): approving the same rules again, after a
 * revoke say, never revives attestations issued under the earlier version.
 */
export async function setAgentPolicy(agentId: string, raw: unknown) {
  const doc = writablePolicySchema.parse(raw);
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const version = (agent.policy?.version ?? 0) + 1;
  const policyHash = policyAnchorHash(doc, version);
  const data = {
    allowed: JSON.stringify(doc.allowed),
    blocked: JSON.stringify(doc.blocked),
    scopeApps: JSON.stringify(doc.scopeApps),
    assets: JSON.stringify(doc.assets),
    version,
    active: true,
    txHash: null,
    anchorMode: null,
    policyHash,
  };
  await db.policy.upsert({ where: { agentId }, create: { agentId, ...data }, update: data });
  const receipt = await setPolicyOnChain(toAgentRef(agent, agent.identity), policyHash, version);
  // Record the receipt on this version only (a newer approval or a revoke may have landed meanwhile).
  await db.policy.updateMany({ where: { agentId, version }, data: { txHash: receipt.txHash, anchorMode: anchorStateOf(receipt) } });
  const policy = await db.policy.findUniqueOrThrow({ where: { agentId } });
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

/** Runs every task even when one fails (a kill switch should do as much as it can on-chain). */
async function syncOnChain(tasks: { op: string; run: () => Promise<ChainReceipt | null> }[]): Promise<ChainSync> {
  const receipts: ChainSync["receipts"] = [];
  const errors: string[] = [];
  for (const t of tasks) {
    try {
      const r = await t.run();
      if (r) receipts.push({ op: t.op, txHash: r.txHash, mode: r.mode, status: r.status });
    } catch (err) {
      errors.push(err instanceof ChainWriteError ? err.message : `${t.op}: ${(err as Error).message}`);
    }
  }
  return errors.length ? { ok: false, receipts, error: errors.join("; ") } : { ok: true, receipts };
}

/**
 * Voids every outstanding FukuSpendGuard attestation for the agent (guard.bumpValidAfter, sent by
 * Fuku as an enforcer, no owner signature needed). Only agents that can hold attestations: an
 * A-Token passport now, or a guarded transfer before.
 */
async function guardBumpTask(agent: { id: string; policy: Parameters<typeof parsePolicy>[0] }, ref: AgentRef) {
  const guarded = isATokenPassport(parsePolicy(agent.policy)) || (await db.agentAction.count({ where: { agentId: agent.id, complianceRef: { not: null } } })) > 0;
  return guarded ? [{ op: "bumpValidAfter", run: () => bumpValidAfterOnChain(ref) }] : [];
}

/**
 * Kill switch: revoke the passport (the agent is also paused in Fuku). The database changes first
 * (fail safe: Fuku stops allowing the agent immediately). Then, on-chain: FukuSpendGuard's
 * validAfter is bumped (every outstanding attestation is void at once, even while an owner-controlled
 * agent's registry write waits for the owner), and PermissionRegistry.revokePolicy follows. The
 * on-chain agent status is left to the explicit pause / resume switch (AgentRegistry.setStatus), so
 * the two switches stay distinguishable on-chain.
 */
export async function revokeAgentPolicy(agentId: string) {
  await db.policy.updateMany({ where: { agentId }, data: { active: false } });
  await db.agent.update({ where: { id: agentId }, data: { status: "paused" } });
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const ref = toAgentRef(agent, agent.identity);
  const chainSync = await syncOnChain([...(await guardBumpTask(agent, ref)), { op: "revokePolicy", run: () => revokePolicyOnChain(ref) }]);
  return { score: await refreshScore(agentId), chainSync };
}

/** Pause also bumps the guard's validAfter, so a later resume cannot revive earlier attestations. */
export async function setAgentStatus(agentId: string, status: "active" | "paused") {
  await db.agent.update({ where: { id: agentId }, data: { status } });
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true } });
  const ref = toAgentRef(agent, agent.identity);
  const bump = status === "paused" ? await guardBumpTask(agent, ref) : [];
  const chainSync = await syncOnChain([...bump, { op: `setStatus(${status})`, run: () => setAgentStatusOnChain(ref, status) }]);
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
