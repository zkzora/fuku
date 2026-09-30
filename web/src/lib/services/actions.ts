import { db } from "../db";
import { evaluate } from "../engine/permission";
import { labelFor, parsePolicy } from "../engine/policy";
import { explainDecision } from "../engine/explain";
import { decisionProofHash, recordDecisionOnChain, toAgentRef, updateScoreOnChain, type ChainReceipt } from "../chain";
import { refreshScore, scoreFor, spentTodayUsdc } from "./agents";
import type { Hex } from "viem";

export interface WorkflowStep {
  step: string;
  status: "ok" | "blocked" | "skipped";
  detail: string;
  ms: number;
}

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc: number | null;
  app: string | null;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  reason: string;
  proofHash: Hex;
  receipt: ChainReceipt;
  scoreBefore: number;
  scoreAfter: number;
  trustDelta: number;
  explanation: string;
  explanationProvider: string;
  workflow: WorkflowStep[];
  createdAt: string;
}

/**
 * The Fuku action workflow (request → verify → execute/block → record → score → explain).
 * Modelled on a Chainlink CRE workflow so it can be lifted into CRE without changing the
 * contract surface. Every step is traced for the activity timeline.
 */
export async function executeAction(input: {
  identityId: string;
  agentId: string;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  params?: Record<string, unknown>;
}): Promise<ActionResult> {
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
  mark("Request received", "ok", `${agent.name} requested ${input.action}${input.amountUsdc ? ` for ${input.amountUsdc} USDC` : ""}`);

  mark(
    "Owner verified",
    agent.identity.humanVerified ? "ok" : "blocked",
    agent.identity.humanVerified
      ? `${agent.identity.displayName} is a verified human (passkey)`
      : `${agent.identity.displayName} is not human-verified`,
  );

  const policy = parsePolicy(agent.policy);
  const spent = await spentTodayUsdc(agent.id, input.action);
  const evaluation = evaluate({
    agentStatus: agent.status,
    policy,
    policyActive: Boolean(agent.policy?.active),
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    spentTodayUsdc: spent,
  });
  mark("Passport evaluated", evaluation.decision === "ALLOWED" ? "ok" : "blocked", `Rule ${evaluation.ruleId}: ${evaluation.reason}`);

  const scoreBefore = scoreFor(agent, agent.identity, agent.reputationEvents).score;
  const createdAt = new Date();
  const proofHash = decisionProofHash({
    agentId: agent.id,
    action: input.action,
    amountUsdc: input.amountUsdc ?? null,
    app: input.app ?? null,
    decision: evaluation.decision,
    ruleId: evaluation.ruleId,
    policyHash: (agent.policy?.policyHash as Hex | null) ?? null,
    at: createdAt.toISOString(),
  });

  if (evaluation.decision === "ALLOWED") {
    mark("Action executed", "ok", `${input.action} executed within passport limits`);
  } else {
    mark("Action executed", "blocked", "Execution halted before any state change");
  }

  const actionRow = await db.agentAction.create({
    data: {
      agentId: agent.id,
      identityId: agent.identityId,
      action: input.action,
      amountUsdc: input.amountUsdc ?? null,
      app: input.app ?? null,
      params: input.params ? JSON.stringify(input.params) : null,
      decision: evaluation.decision,
      reason: evaluation.reason,
      ruleId: evaluation.ruleId,
      proofHash,
      createdAt,
    },
  });

  const receipt = await recordDecisionOnChain({
    agent: toAgentRef(agent, agent.identity),
    actionId: actionRow.id,
    allowed: evaluation.decision === "ALLOWED",
    proofHash,
    ruleId: evaluation.ruleId,
  });
  mark("Proof anchored on Monad", "ok", `${receipt.mode === "live" ? "tx" : "mock tx"} ${receipt.txHash.slice(0, 10)}… · block ${receipt.block.toLocaleString("en-US")}`);

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
    await updateScoreOnChain(toAgentRef(agent, agent.identity), after.score, trustDelta, `${evaluation.decision}:${evaluation.ruleId}`);
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
    data: { txHash: receipt.txHash, trustDelta, explanation: explanation.text },
  });

  return {
    id: actionRow.id,
    agentId: agent.id,
    agentName: agent.name,
    action: input.action,
    amountUsdc: input.amountUsdc ?? null,
    app: input.app ?? null,
    decision: evaluation.decision,
    ruleId: evaluation.ruleId,
    reason: evaluation.reason,
    proofHash,
    receipt,
    scoreBefore,
    scoreAfter: after.score,
    trustDelta,
    explanation: explanation.text,
    explanationProvider: explanation.provider,
    workflow: trace,
    createdAt: createdAt.toISOString(),
  };
}
