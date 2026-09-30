import type { Agent, Identity, Policy } from "@prisma/client";
import type { Address, Hex } from "viem";
import { db } from "../db";
import { evaluate, type Evaluation } from "../engine/permission";
import { isATokenPassport, labelFor, parsePolicy, VALUE_ACTIONS, type PolicyDoc } from "../engine/policy";
import { explainDecision } from "../engine/explain";
import {
  ChainWriteError,
  decisionProofHash,
  executeGuardedTransfer,
  recordDecisionOnChain,
  toAgentRef,
  updateScoreOnChain,
  type ChainReceipt,
} from "../chain";
import { legText } from "../cleanverse/compliance";
import type { ComplianceLeg, ComplianceResult } from "../cleanverse/types";
import { refreshScore, scoreFor, spentTodayUsdc } from "./agents";
import { complianceFor } from "./cleanverse";

export interface WorkflowStep {
  step: string;
  status: "ok" | "blocked" | "skipped";
  detail: string;
  ms: number;
}

/** Cleanverse evidence as returned to callers (the three legs plus the anchored reference). */
export interface ComplianceView {
  mode: ComplianceResult["mode"];
  asset: ComplianceLeg;
  owner: ComplianceLeg;
  counterparty: ComplianceLeg;
  complianceRef: Hex;
  evidence: ComplianceResult["evidence"];
}

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc: number | null;
  app: string | null;
  to: string | null;
  asset: string | null;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  subCode: Evaluation["subCode"] | null;
  reason: string;
  proofHash: Hex;
  receipt: ChainReceipt;
  /** Set when an A-Token moved through FukuSpendGuard (the same tx also records the decision). */
  transfer: { txHash: Hex; explorerUrl: string; mode: ChainReceipt["mode"] } | null;
  compliance: ComplianceView | null;
  scoreBefore: number;
  scoreAfter: number;
  trustDelta: number;
  explanation: string;
  explanationProvider: string;
  workflow: WorkflowStep[];
  createdAt: string;
}

export interface ActionInput {
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  /** Recipient wallet for `transfer`. */
  to?: string | null;
  /** A-Token symbol for `transfer` on an A-Token passport (e.g. "aUSDC"). */
  asset?: string | null;
}

type AgentForAssessment = Agent & { policy: Policy | null; identity: Identity };

/** Rules decided before Cleanverse is consulted: no provider call when one of them already blocks. */
const PRE_COMPLIANCE_RULES = new Set(["R0", "R1", "R2", "R3", "R4"]);

export function needsCompliance(policy: PolicyDoc | null, action: string) {
  return isATokenPassport(policy) && VALUE_ACTIONS.has(action);
}

/**
 * Evaluate an action against the passport, gathering Cleanverse evidence first when it is a value
 * action on an A-Token passport. Shared by execute (which then acts on it) and check (which does not).
 */
export async function assessAction(agent: AgentForAssessment, input: ActionInput) {
  const policy = parsePolicy(agent.policy);
  const spent = await spentTodayUsdc(agent.id, input.action);
  const base = {
    agentStatus: agent.status,
    policy,
    policyActive: Boolean(agent.policy?.active),
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    spentTodayUsdc: spent,
  };
  const first = evaluate(base);
  if (!needsCompliance(policy, input.action) || PRE_COMPLIANCE_RULES.has(first.ruleId)) {
    return { policy, evaluation: first, compliance: null as ComplianceResult | null };
  }
  const compliance = await complianceFor({
    action: input.action,
    assetSymbol: input.asset,
    passportAssets: policy?.assets ?? [],
    ownerWallet: agent.identity.walletAddress,
    counterparty: input.to,
  });
  return { policy, evaluation: evaluate({ ...base, compliance }), compliance };
}

export function complianceView(c: ComplianceResult | null): ComplianceView | null {
  if (!c) return null;
  return { mode: c.mode, asset: c.asset, owner: c.owner, counterparty: c.counterparty, complianceRef: c.complianceRef, evidence: c.evidence };
}

const legStatus = (leg: ComplianceLeg): WorkflowStep["status"] =>
  leg.ok ? "ok" : leg.subCode === "PROVIDER_ERROR" && leg.detail.startsWith("not evaluated") ? "skipped" : "blocked";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The Fuku action workflow (request → verify → execute/block → record → score → explain).
 * Modelled on a Chainlink CRE workflow so it can be lifted into CRE without changing the
 * contract surface. Every step is traced for the activity timeline.
 *
 * An allowed `transfer` on an A-Token passport moves the token through FukuSpendGuard: the row is
 * created first (its id is the on-chain actionHash), the compliance signer attests to the exact
 * transfer, and the guard records the decision itself. If the guard would revert, the decision
 * becomes BLOCKED with R10.
 */
export async function executeAction(input: ActionInput & { identityId: string; agentId: string; params?: Record<string, unknown> }): Promise<ActionResult> {
  const trace: WorkflowStep[] = [];
  const t0 = Date.now();
  const mark = (step: string, status: WorkflowStep["status"], detail: string) => {
    trace.push({ step, status, detail, ms: Date.now() - t0 });
  };

  const agent = await db.agent.findFirst({
    where: { id: input.agentId, identityId: input.identityId },
    include: { policy: true, identity: true, reputationEvents: { select: { kind: true } } },
  });
  if (!agent) throw new Error("Agent not found for this identity");
  mark(
    "Request received",
    "ok",
    `${agent.name} requested ${input.action}${input.amountUsdc ? ` for ${input.amountUsdc} ${input.asset ?? "USDC"}` : ""}${input.to ? ` to ${short(input.to)}` : ""}`,
  );

  mark(
    "Owner verified",
    agent.identity.humanVerified ? "ok" : "blocked",
    agent.identity.humanVerified
      ? `${agent.identity.displayName} is a verified human (passkey)`
      : `${agent.identity.displayName} is not human-verified`,
  );

  const assessed = await assessAction(agent, input);
  const { policy, compliance } = assessed;
  let evaluation = assessed.evaluation;
  if (compliance) {
    const sim = compliance.mode === "simulated" ? " (Cleanverse simulator)" : "";
    mark("Cleanverse CVA: asset rule", legStatus(compliance.asset), legText(compliance.asset) + sim);
    mark("Cleanverse CVI: owner A-Pass", legStatus(compliance.owner), legText(compliance.owner) + sim);
    mark("Cleanverse CVI: counterparty", legStatus(compliance.counterparty), legText(compliance.counterparty) + sim);
  }
  mark("Passport evaluated", evaluation.decision === "ALLOWED" ? "ok" : "blocked", `Rule ${evaluation.ruleId}: ${evaluation.reason}`);

  const scoreBefore = scoreFor(agent, agent.identity, agent.reputationEvents).score;
  const createdAt = new Date();
  const policyHash = (agent.policy?.policyHash as Hex | null) ?? null;
  const proofOf = (e: Evaluation) =>
    decisionProofHash({
      agentId: agent.id,
      action: input.action,
      amountUsdc: input.amountUsdc ?? null,
      app: input.app ?? null,
      decision: e.decision,
      ruleId: e.ruleId,
      policyHash,
      at: createdAt.toISOString(),
      complianceRef: compliance?.complianceRef ?? null,
    });
  let proofHash = proofOf(evaluation);

  const actionRow = await db.agentAction.create({
    data: {
      agentId: agent.id,
      identityId: agent.identityId,
      action: input.action,
      amountUsdc: input.amountUsdc ?? null,
      app: input.app ?? null,
      counterparty: input.to?.toLowerCase() ?? null,
      asset: input.asset ?? null,
      params: input.params ? JSON.stringify(input.params) : null,
      decision: evaluation.decision,
      reason: evaluation.reason,
      ruleId: evaluation.ruleId,
      proofHash,
      compliance: compliance ? JSON.stringify(complianceView(compliance)) : null,
      complianceRef: compliance?.complianceRef ?? null,
      createdAt,
    },
  });

  const agentRef = toAgentRef(agent, agent.identity);
  let receipt: ChainReceipt | null = null;
  let transfer: ActionResult["transfer"] = null;

  if (evaluation.decision === "ALLOWED" && compliance) {
    let outcome;
    try {
      outcome = await executeGuardedTransfer({
        agent: agentRef,
        actionId: actionRow.id,
        from: agent.identity.walletAddress as Address,
        to: input.to as Address,
        token: compliance.evidence.atoken.address as Address,
        amountUsdc: input.amountUsdc ?? 0,
        proofHash,
        complianceRef: compliance.complianceRef,
      });
    } catch (err) {
      // RPC / signing failure: nothing moved and nothing was recorded on-chain. Keep the row honest
      // (and out of the daily cap), then surface the error to the caller.
      if (err instanceof ChainWriteError) {
        await db.agentAction.update({
          where: { id: actionRow.id },
          data: { decision: "BLOCKED", ruleId: "R10", reason: `Guarded transfer not sent: ${err.reason}` },
        });
      }
      throw err;
    }
    if (outcome.status === "executed") {
      receipt = outcome.receipt;
      transfer = { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl, mode: receipt.mode };
      mark(
        "Guarded transfer on Monad",
        "ok",
        `${input.amountUsdc} ${compliance.evidence.atoken.symbol} → ${short(input.to!)} via FukuSpendGuard · ${receipt.mode === "live" ? "tx" : "mock tx"} ${receipt.txHash.slice(0, 10)}…`,
      );
      mark("Proof anchored on Monad", "ok", `Recorded by FukuSpendGuard in the same tx (R6) · block ${receipt.block.toLocaleString("en-US")}`);
    } else {
      const notConfigured = outcome.reason === "GUARD_NOT_CONFIGURED";
      evaluation = {
        decision: "BLOCKED",
        ruleId: "R10",
        subCode: notConfigured ? "GUARD_NOT_CONFIGURED" : "GUARD_REJECTED",
        reason: notConfigured
          ? "GUARD_NOT_CONFIGURED: the chain is live but FUKU_SPEND_GUARD or FUKU_COMPLIANCE_SIGNER_KEY is not set, so no A-Token can move."
          : `GUARD_REJECTED: the on-chain FukuSpendGuard would revert with ${outcome.reason}.`,
      };
      proofHash = proofOf(evaluation);
      await db.agentAction.update({
        where: { id: actionRow.id },
        data: { decision: evaluation.decision, ruleId: evaluation.ruleId, reason: evaluation.reason, proofHash },
      });
      mark("Guarded transfer on Monad", "blocked", `R10 ${outcome.reason}`);
    }
  } else if (evaluation.decision === "ALLOWED") {
    mark("Action executed", "ok", `${input.action} executed within passport limits`);
  } else {
    mark("Action executed", "blocked", "Execution halted before any state change");
  }

  if (!receipt) {
    receipt = await recordDecisionOnChain({
      agent: agentRef,
      actionId: actionRow.id,
      allowed: evaluation.decision === "ALLOWED",
      proofHash,
      ruleId: evaluation.ruleId,
    });
    mark("Proof anchored on Monad", "ok", `${receipt.mode === "live" ? "tx" : "mock tx"} ${receipt.txHash.slice(0, 10)}… · block ${receipt.block.toLocaleString("en-US")}`);
  }

  await db.reputationEvent.create({
    data: {
      agentId: agent.id,
      kind: evaluation.decision === "ALLOWED" ? "success" : "violation",
      delta: 0,
      note: evaluation.decision === "ALLOWED" ? `Allowed: ${labelFor(input.action)}` : `Blocked: ${labelFor(input.action)} (${evaluation.ruleId})`,
    },
  });
  const after = await refreshScore(agent.id);
  const trustDelta = after.score - scoreBefore;
  await db.reputationEvent.updateMany({
    where: { agentId: agent.id, delta: 0, createdAt: { gte: createdAt } },
    data: { delta: trustDelta },
  });
  if (trustDelta !== 0) {
    await updateScoreOnChain(agentRef, after.score, trustDelta, `${evaluation.decision}:${evaluation.ruleId}`);
  }
  mark("Reputation updated", "ok", `Trust score ${scoreBefore} → ${after.score} (${trustDelta >= 0 ? "+" : ""}${trustDelta})`);

  const explanation = await explainDecision({
    agentName: agent.name,
    ownerName: agent.identity.displayName,
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    evaluation,
    policy,
    scoreBefore,
    scoreAfter: after.score,
  });
  mark("Explanation generated", "ok", `by ${explanation.provider}`);

  await db.agentAction.update({
    where: { id: actionRow.id },
    data: { txHash: receipt.txHash, transferTxHash: transfer?.txHash ?? null, trustDelta, explanation: explanation.text },
  });

  return {
    id: actionRow.id,
    agentId: agent.id,
    agentName: agent.name,
    action: input.action,
    amountUsdc: input.amountUsdc ?? null,
    app: input.app ?? null,
    to: input.to?.toLowerCase() ?? null,
    asset: input.asset ?? null,
    decision: evaluation.decision,
    ruleId: evaluation.ruleId,
    subCode: evaluation.subCode ?? null,
    reason: evaluation.reason,
    proofHash,
    receipt,
    transfer,
    compliance: complianceView(compliance),
    scoreBefore,
    scoreAfter: after.score,
    trustDelta,
    explanation: explanation.text,
    explanationProvider: explanation.provider,
    workflow: trace,
    createdAt: createdAt.toISOString(),
  };
}
