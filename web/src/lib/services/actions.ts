import { Prisma, type Agent, type AgentAction, type Identity, type Policy } from "@prisma/client";
import type { Address, Hex } from "viem";
import { db } from "../db";
import { evaluate, fromMicros, PRE_COMPLIANCE_RULES, toMicros, type Evaluation } from "../engine/permission";
import { isATokenPassport, labelFor, parsePolicy, VALUE_ACTIONS, type PolicyDoc } from "../engine/policy";
import { isViolation } from "../engine/reputation";
import { explainDecision } from "../engine/explain";
import {
  anchorStateOf,
  ChainWriteError,
  executeGuardedTransfer,
  recordDecisionOnChain,
  toAgentRef,
  updateScoreOnChain,
  type ChainReceipt,
} from "../chain";
import { legText } from "../cleanverse/compliance";
import type { ComplianceLeg, ComplianceResult } from "../cleanverse/types";
import { ForbiddenError, RequestError } from "../errors";
import { hashJson, hashString } from "../ids";
import { newActionId, recordHash, recordJson } from "../records";
import { refreshScore, SCORED_EVENTS, scoreFor } from "./agents";
import { canActFor } from "./authz";
import { releaseBudget, reserveBudget, spentMicros } from "./budget";
import { apassEligibleFor, complianceFor, travelRuleFor } from "./cleanverse";

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

/**
 * Execution lifecycle, separate from the policy decision:
 *   DENIED      the engine (or the on-chain guard's pre-check, R10) blocked it; nothing executed
 *   AUTHORIZED  allowed; Fuku records the decision but does not execute this kind of action
 *   SUBMITTED   a guarded transfer was broadcast; its receipt is being awaited
 *   CONFIRMED   the guarded transfer is mined and succeeded (execution evidence)
 *   PENDING     broadcast, but no receipt within the timeout; reconciliation settles it
 *   FAILED      allowed, but execution failed (not sent, or mined and reverted); nothing moved
 *   SIMULATED   mock-chain mode: the transfer path ran, nothing moved
 */
export type ExecutionStatus = "DENIED" | "AUTHORIZED" | "SUBMITTED" | "CONFIRMED" | "PENDING" | "FAILED" | "SIMULATED";

export interface ActionResult {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc: number | null;
  /** Authoritative amount in 6-decimal base units (decimal string). */
  amountBaseUnits: string | null;
  app: string | null;
  to: string | null;
  asset: string | null;
  decision: "ALLOWED" | "BLOCKED";
  status: ExecutionStatus;
  ruleId: string;
  subCode: Evaluation["subCode"] | null;
  reason: string;
  proofHash: Hex;
  /** The decision anchor (or, for a guarded transfer, the transfer tx that records it). */
  receipt: ChainReceipt;
  /** Set when an A-Token moved (or was attempted) through FukuSpendGuard. */
  transfer: {
    txHash: Hex | null;
    explorerUrl: string | null;
    mode: ChainReceipt["mode"];
    status: ChainReceipt["status"];
    block: number | null;
    logIndex: number | null;
  } | null;
  compliance: ComplianceView | null;
  /** keccak256 of the Travel Rule record for a guarded transfer (download it from the action). */
  travelRuleRef: Hex | null;
  idempotencyKey: string | null;
  /** True when this response is a replay of an earlier request with the same idempotency key. */
  replayed: boolean;
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

export function needsCompliance(policy: PolicyDoc | null, action: string) {
  return isATokenPassport(policy) && VALUE_ACTIONS.has(action);
}

/**
 * Evaluate an action against the passport, the owner's verification and today's authoritative
 * budget, gathering Cleanverse evidence only when it is a value action on an A-Token passport and
 * no provider-free rule already blocks it. Shared by execute (which then acts on it), check (which
 * does not) and therefore by the SDK and CRE, which call those routes.
 */
export async function assessAction(agent: AgentForAssessment, input: ActionInput) {
  const policy = parsePolicy(agent.policy);
  const spent = VALUE_ACTIONS.has(input.action) ? await spentMicros(agent.id, input.action) : BigInt(0);
  const base = {
    agentStatus: agent.status,
    policy,
    policyActive: Boolean(agent.policy?.active),
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    to: input.to,
    ownerVerified: agent.identity.humanVerified,
    spentTodayUsdc: fromMicros(spent),
    spentTodayMicros: spent,
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
    ownerWalletVerified: Boolean(agent.identity.walletVerifiedBy),
    counterparty: input.to,
  });
  return { policy, evaluation: evaluate({ ...base, compliance }), compliance };
}

export function complianceView(c: ComplianceResult | null): ComplianceView | null {
  if (!c) return null;
  return { mode: c.mode, asset: c.asset, owner: c.owner, counterparty: c.counterparty, complianceRef: c.complianceRef, evidence: c.evidence };
}

/** HTTP status for a result: 403 blocked, 202 still pending on-chain, 200 otherwise. */
export function httpStatusOf(r: Pick<ActionResult, "decision" | "status">) {
  return r.decision === "BLOCKED" ? 403 : r.status === "PENDING" || r.status === "SUBMITTED" ? 202 : 200;
}

const legStatus = (leg: ComplianceLeg): WorkflowStep["status"] =>
  leg.ok ? "ok" : leg.subCode === "PROVIDER_ERROR" && leg.detail.startsWith("not evaluated") ? "skipped" : "blocked";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const requestHashOf = (input: ActionInput & { params?: Record<string, unknown> }) =>
  hashJson({
    action: input.action,
    amountUsdc: input.amountUsdc ?? null,
    app: input.app ?? null,
    to: input.to?.toLowerCase() ?? null,
    asset: input.asset ?? null,
    params: input.params ?? null,
  });

/** An earlier request with this idempotency key: replay it, or refuse a conflicting / in-flight one. */
function replay(existing: AgentAction, requestHash: string): ActionResult {
  if (existing.requestHash !== requestHash) {
    throw new RequestError("This Idempotency-Key was already used with a different request.", 422, "idempotency_mismatch");
  }
  if (!existing.resultJson) {
    throw new RequestError("A request with this Idempotency-Key is still in progress.", 409, "idempotency_in_progress");
  }
  const stored = JSON.parse(existing.resultJson) as ActionResult & { error?: string };
  if (stored.error) throw new RequestError(`The earlier attempt with this Idempotency-Key failed: ${stored.error}. Retry with a new key.`, 409, "idempotency_failed");
  return { ...stored, status: (existing.status as ExecutionStatus) ?? stored.status, replayed: true };
}

/**
 * The Fuku action workflow (request → authorize → verify → execute/block → record → score → explain).
 * Modelled on a Chainlink CRE workflow so it can be lifted into CRE without changing the contract
 * surface. Every step is traced for the activity timeline.
 *
 * An allowed `transfer` on an A-Token passport moves the token through FukuSpendGuard: the row is
 * created first (its id is the on-chain, single-use actionHash), the daily budget is reserved
 * atomically, the compliance signer attests to the exact transfer, and the guard records the
 * decision itself. Allowed actions Fuku does not execute are recorded as AUTHORIZED.
 */
export async function executeAction(
  input: ActionInput & { callerId: string; agentId: string; params?: Record<string, unknown>; idempotencyKey?: string | null },
): Promise<ActionResult> {
  const trace: WorkflowStep[] = [];
  const t0 = Date.now();
  const mark = (step: string, status: WorkflowStep["status"], detail: string) => {
    trace.push({ step, status, detail, ms: Date.now() - t0 });
  };

  const agent = await db.agent.findUnique({
    where: { id: input.agentId },
    include: { policy: true, identity: true, reputationEvents: SCORED_EVENTS },
  });
  if (!agent) throw new Error("Agent not found");
  const actor = await canActFor(input.callerId, agent.identityId, "agents:execute");
  if (!actor.ok) throw new ForbiddenError("Not authorized to execute actions for this agent. The owner must grant an agents:execute delegation.");

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const requestHash = requestHashOf(input);
  if (idempotencyKey) {
    const existing = await db.agentAction.findUnique({ where: { agentId_idempotencyKey: { agentId: agent.id, idempotencyKey } } });
    if (existing) return replay(existing, requestHash);
  }

  mark(
    "Request received",
    "ok",
    `${agent.name} requested ${input.action}${input.amountUsdc ? ` for ${input.amountUsdc} ${input.asset ?? "USDC"}` : ""}${input.to ? ` to ${short(input.to)}` : ""}${actor.via !== "self" ? ` (via ${actor.via})` : ""}`,
  );
  mark(
    "Owner verified",
    agent.identity.humanVerified ? "ok" : "blocked",
    agent.identity.humanVerified
      ? `${agent.identity.displayName} completed a passkey ceremony with user verification`
      : `${agent.identity.displayName} has not completed a passkey ceremony (value actions are blocked, R11)`,
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

  const apassEligible = await apassEligibleFor(agent.identity);
  const scoreBefore = scoreFor(agent, agent.identity, agent.reputationEvents, { apassEligible }).score;
  const createdAt = new Date();
  const policyHash = (agent.policy?.policyHash as Hex | null) ?? null;
  const isValue = VALUE_ACTIONS.has(input.action);
  const amountMicros = isValue && input.amountUsdc != null ? toMicros(input.amountUsdc) : null;
  // The proof commits to a decision record Fuku keeps and can reveal (lib/records.ts); the action
  // id is part of it, so it is chosen before the row exists.
  const actionId = newActionId();
  const proofOf = (e: Evaluation, guardReason: string | null = null): Hex => {
    const json = recordJson({
      actionId,
      agentId: agent.id,
      action: input.action,
      amountUsdc: input.amountUsdc ?? null,
      app: input.app ?? null,
      decision: e.decision === "ALLOWED" ? "ALLOWED" : "BLOCKED",
      ruleId: e.ruleId,
      subCode: e.subCode ?? null,
      guardReason,
      policyHash,
      complianceRef: compliance?.complianceRef ?? null,
      at: createdAt.toISOString(),
      seeded: null,
      outcome: null,
    });
    const hash = recordHash(json);
    pendingRecord = { json, hash };
    return hash;
  };
  let pendingRecord: { json: string; hash: Hex } | null = null;
  const keepRecord = async () => {
    if (!pendingRecord) return;
    const { json, hash } = pendingRecord;
    await db.decisionRecord.upsert({
      where: { actionId },
      create: { actionId, agentId: agent.id, proofHash: hash, record: json },
      update: { proofHash: hash, record: json },
    });
  };
  let proofHash = proofOf(evaluation);

  let actionRow: AgentAction;
  try {
    actionRow = await db.agentAction.create({
      data: {
        id: actionId,
        agentId: agent.id,
        identityId: agent.identityId,
        action: input.action,
        amountUsdc: input.amountUsdc ?? null,
        amountMicros,
        app: input.app ?? null,
        counterparty: input.to?.toLowerCase() ?? null,
        asset: input.asset ?? null,
        params: input.params ? JSON.stringify(input.params) : null,
        decision: evaluation.decision,
        status: evaluation.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED",
        reason: evaluation.reason,
        ruleId: evaluation.ruleId,
        proofHash,
        policyVersion: agent.policy?.version ?? null,
        idempotencyKey,
        requestHash,
        compliance: compliance ? JSON.stringify(complianceView(compliance)) : null,
        complianceRef: compliance?.complianceRef ?? null,
        createdAt,
      },
    });
  } catch (err) {
    // Two concurrent requests with one idempotency key: the loser replays the winner (its record is never kept).
    if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.agentAction.findUnique({ where: { agentId_idempotencyKey: { agentId: agent.id, idempotencyKey } } });
      if (existing) return replay(existing, requestHash);
    }
    throw err;
  }
  await keepRecord();

  const setStatus = async (data: Prisma.AgentActionUpdateInput) => {
    const row = await db.agentAction.update({ where: { id: actionRow.id }, data });
    if (data.proofHash) await keepRecord();
    return row;
  };

  // Reserve today's budget atomically before anything executes. Losing a race is an R5 block.
  let reservedDay: string | null = null;
  const rule = policy?.allowed.find((r) => r.action === input.action);
  if (evaluation.decision === "ALLOWED" && isValue && amountMicros !== null && rule?.limitUsdcPerDay !== undefined) {
    const limit = toMicros(rule.limitUsdcPerDay) ?? BigInt(0);
    const reserved = await reserveBudget(agent.id, input.action, amountMicros, limit, createdAt);
    if (reserved.ok) {
      reservedDay = reserved.day;
      mark("Daily budget reserved", "ok", `${input.amountUsdc} of ${rule.limitUsdcPerDay} USDC/day (UTC), atomically`);
    } else {
      const remaining = limit > reserved.spent ? limit - reserved.spent : BigInt(0);
      evaluation = {
        decision: "BLOCKED",
        ruleId: "R5",
        reason: `${labelFor(input.action)} of ${input.amountUsdc} USDC exceeds the remaining daily limit of ${fromMicros(remaining)} USDC (a concurrent request reserved it first).`,
        limitUsdcPerDay: rule.limitUsdcPerDay,
        remainingUsdc: fromMicros(remaining),
      };
      proofHash = proofOf(evaluation);
      await setStatus({ decision: "BLOCKED", status: "DENIED", ruleId: "R5", reason: evaluation.reason, proofHash });
      mark("Daily budget reserved", "blocked", "Another request used the remaining budget first");
    }
  }
  const release = async () => {
    if (reservedDay && amountMicros !== null) {
      await releaseBudget(agent.id, input.action, amountMicros, reservedDay);
      reservedDay = null;
    }
  };

  const agentRef = toAgentRef(agent, agent.identity);
  let status: ExecutionStatus = evaluation.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED";
  let receipt: ChainReceipt | null = null;
  let transfer: ActionResult["transfer"] = null;
  let travelRuleRef: Hex | null = null;

  if (evaluation.decision === "ALLOWED" && compliance && amountMicros !== null) {
    let outcome;
    try {
      outcome = await executeGuardedTransfer({
        agent: agentRef,
        actionId: actionRow.id,
        from: agent.identity.walletAddress as Address,
        to: input.to as Address,
        token: compliance.evidence.atoken.address as Address,
        amount: amountMicros,
        proofHash,
        complianceRef: compliance.complianceRef,
        policyVersion: agent.policy?.version ?? 0,
        onSubmitted: async (hash) => {
          await setStatus({ status: "SUBMITTED", transferTxHash: hash, txHash: hash, submittedAt: new Date(), receiptMode: "live" });
        },
      });
    } catch (err) {
      // Nothing was broadcast (or broadcasting itself failed): nothing moved, the budget is returned,
      // no reputation changes, and the caller gets the error. The row keeps the decision (ALLOWED)
      // and records the failed execution.
      await release();
      if (err instanceof ChainWriteError) {
        const errorClass = /sign/i.test(err.reason) ? "signing" : "rpc";
        await setStatus({
          status: "FAILED",
          errorClass,
          errorDetail: err.reason.slice(0, 500),
          resultJson: JSON.stringify({ error: err.message, status: "FAILED" }),
        });
      }
      throw err;
    }

    if (outcome.status === "executed") {
      receipt = outcome.receipt;
      status = receipt.mode === "live" ? "CONFIRMED" : "SIMULATED";
      transfer = { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl, mode: receipt.mode, status: receipt.status, block: receipt.block, logIndex: outcome.logIndex };
      await setStatus({
        status,
        transferTxHash: receipt.txHash,
        receiptMode: receipt.mode,
        chainId: receipt.chainId,
        blockNumber: receipt.block,
        blockHash: outcome.blockHash,
        logIndex: outcome.logIndex,
        anchorStatus: anchorStateOf(receipt),
        settledAt: new Date(),
      });
      mark(
        "Guarded transfer on Monad",
        "ok",
        `${input.amountUsdc} ${compliance.evidence.atoken.symbol} → ${short(input.to!)} via FukuSpendGuard · ${receipt.mode === "live" ? "tx" : "mock tx, nothing moved"} ${receipt.txHash?.slice(0, 10)}…`,
      );
      mark("Proof anchored on Monad", "ok", receipt.mode === "live" ? `Recorded by FukuSpendGuard in the same tx (R6) · block ${receipt.block?.toLocaleString("en-US")}` : "Mock receipt (mock chain)");
      // Travel Rule record (Cleanverse's in live mode, the simulator's otherwise); best effort.
      try {
        const tr = await travelRuleFor({
          txHash: receipt.txHash ?? "",
          chainId: receipt.chainId,
          asset: { symbol: compliance.evidence.atoken.symbol, address: compliance.evidence.atoken.address ?? "" },
          amountBaseUnits: amountMicros,
          from: agent.identity.walletAddress ?? "",
          to: input.to ?? "",
          ownerCvRecordId: compliance.evidence.owner.cvRecordId,
          complianceRef: compliance.complianceRef,
        });
        if (tr) {
          travelRuleRef = tr.ref;
          await setStatus({ travelRule: JSON.stringify(tr.record), travelRuleRef: tr.ref });
          mark("Travel Rule record", "ok", `${tr.source === "simulated" ? "Cleanverse simulator" : "Cleanverse"} · ref ${tr.ref.slice(0, 10)}…`);
        }
      } catch (err) {
        mark("Travel Rule record", "skipped", `not available: ${(err as Error).message.slice(0, 120)}`);
      }
    } else if (outcome.status === "pending") {
      receipt = outcome.receipt;
      status = "PENDING";
      transfer = { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl, mode: "live", status: "pending", block: null, logIndex: null };
      await setStatus({ status, receiptMode: "live", chainId: receipt.chainId, errorClass: "timeout", anchorStatus: "pending" });
      mark("Guarded transfer on Monad", "skipped", `Broadcast (tx ${receipt.txHash?.slice(0, 10)}…); waiting for the receipt. Reconciliation settles it.`);
    } else if (outcome.status === "reverted") {
      await release();
      receipt = outcome.receipt;
      status = "FAILED";
      transfer = { txHash: receipt.txHash, explorerUrl: receipt.explorerUrl, mode: "live", status: "failed", block: receipt.block, logIndex: null };
      await setStatus({ status, receiptMode: "live", chainId: receipt.chainId, blockNumber: receipt.block, errorClass: "reverted", errorDetail: outcome.reason, settledAt: new Date() });
      mark("Guarded transfer on Monad", "blocked", `Mined but reverted; nothing moved (${outcome.reason})`);
    } else {
      await release();
      const notConfigured = outcome.reason === "GUARD_NOT_CONFIGURED";
      // The owner revoked or replaced the passport, or paused the agent, after the decision above.
      const changed = /^AUTHORIZATION_CHANGED\((.*)\)$/.exec(outcome.reason);
      evaluation = {
        decision: "BLOCKED",
        ruleId: "R10",
        subCode: notConfigured ? "GUARD_NOT_CONFIGURED" : changed ? "AUTHORIZATION_CHANGED" : "GUARD_REJECTED",
        reason: notConfigured
          ? "GUARD_NOT_CONFIGURED: the chain is live but FUKU_SPEND_GUARD or FUKU_COMPLIANCE_SIGNER_KEY is not set, so no A-Token can move."
          : changed
            ? `AUTHORIZATION_CHANGED: ${changed[1]} after this transfer was authorized. The owner's change wins, so nothing was signed or sent.`
            : `GUARD_REJECTED: the on-chain FukuSpendGuard would revert with ${outcome.reason}.`,
      };
      status = "DENIED";
      proofHash = proofOf(evaluation, outcome.reason);
      await setStatus({ decision: "BLOCKED", status, ruleId: "R10", reason: evaluation.reason, proofHash, errorClass: "guard_revert", errorDetail: outcome.reason });
      mark("Guarded transfer on Monad", "blocked", `R10 ${outcome.reason}`);
    }
  } else if (evaluation.decision === "ALLOWED") {
    mark("Action authorized", "ok", `${labelFor(input.action)} is authorized. Fuku records the decision; the agent's own integration executes it.`);
  } else {
    mark("Action executed", "blocked", "Execution halted before any state change");
  }

  // Every decision without a guard receipt is anchored on its own (denials included, so they persist
  // even though a reverted transaction would leave no trace).
  if (!receipt) {
    receipt = await recordDecisionOnChain({
      agent: agentRef,
      actionId: actionRow.id,
      allowed: evaluation.decision === "ALLOWED",
      proofHash,
      ruleId: evaluation.ruleId,
    });
    await setStatus({ txHash: receipt.txHash, receiptMode: receipt.mode, chainId: receipt.chainId, anchorStatus: anchorStateOf(receipt), blockNumber: receipt.block });
    mark(
      "Proof anchored on Monad",
      receipt.status === "failed" ? "blocked" : "ok",
      receipt.status === "confirmed"
        ? `tx ${receipt.txHash?.slice(0, 10)}… · block ${receipt.block?.toLocaleString("en-US")}`
        : receipt.status === "simulated"
          ? `mock tx ${receipt.txHash?.slice(0, 10)}… (mock chain)`
          : receipt.status === "pending"
            ? `broadcast ${receipt.txHash?.slice(0, 10)}…, receipt pending`
            : `not anchored: ${receipt.note ?? "live write failed"} (reconciliation retries)`,
    );
  }

  // Reputation: only verifiable outcomes move the score, once per action.
  const kind =
    status === "CONFIRMED" ? "success" : status === "DENIED" ? (isViolation(evaluation.ruleId, evaluation.subCode, evaluation.reason) ? "violation" : "neutral") : null;
  let scoreAfter = scoreBefore;
  if (kind) {
    await db.reputationEvent.create({
      data: {
        agentId: agent.id,
        actionId: actionRow.id,
        kind,
        delta: 0,
        note:
          kind === "success"
            ? `Executed: ${labelFor(input.action)} ${input.amountUsdc ?? ""} (tx ${receipt?.txHash?.slice(0, 10)}…)`
            : `${kind === "violation" ? "Blocked" : "Blocked (not the agent's fault)"}: ${labelFor(input.action)} (${evaluation.ruleId}${evaluation.subCode ? ` ${evaluation.subCode}` : ""})`,
      },
    });
    const after = await refreshScore(agent.id);
    scoreAfter = after.score;
    await db.reputationEvent.update({ where: { actionId: actionRow.id }, data: { delta: scoreAfter - scoreBefore } });
    if (scoreAfter !== scoreBefore) {
      await updateScoreOnChain(agentRef, scoreAfter, scoreAfter - scoreBefore, `${evaluation.decision}:${evaluation.ruleId}`);
    }
  }
  const trustDelta = scoreAfter - scoreBefore;
  mark(
    "Reputation updated",
    kind ? "ok" : "skipped",
    kind ? `Trust score ${scoreBefore} → ${scoreAfter} (${trustDelta >= 0 ? "+" : ""}${trustDelta})` : `No change: ${status.toLowerCase()} actions carry no execution evidence`,
  );

  const explanation = await explainDecision({
    agentName: agent.name,
    ownerName: agent.identity.displayName,
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    evaluation,
    policy,
    scoreBefore,
    scoreAfter,
  });
  mark("Explanation generated", "ok", `by ${explanation.provider}`);

  const result: ActionResult = {
    id: actionRow.id,
    agentId: agent.id,
    agentName: agent.name,
    action: input.action,
    amountUsdc: input.amountUsdc ?? null,
    amountBaseUnits: amountMicros?.toString() ?? null,
    app: input.app ?? null,
    to: input.to?.toLowerCase() ?? null,
    asset: input.asset ?? null,
    decision: evaluation.decision,
    status,
    ruleId: evaluation.ruleId,
    subCode: evaluation.subCode ?? null,
    reason: evaluation.reason,
    proofHash,
    receipt,
    transfer,
    compliance: complianceView(compliance),
    travelRuleRef,
    idempotencyKey,
    replayed: false,
    scoreBefore,
    scoreAfter,
    trustDelta,
    explanation: explanation.text,
    explanationProvider: explanation.provider,
    workflow: trace,
    createdAt: createdAt.toISOString(),
  };
  await setStatus({ trustDelta, explanation: explanation.text, resultJson: JSON.stringify(result) });
  return result;
}

/** One action with its lifecycle and evidence, for the caller that may execute for its agent. */
export async function getActionReceipt(caller: Identity, actionId: string) {
  const row = await db.agentAction.findUnique({ where: { id: actionId }, include: { agent: { select: { name: true } } } });
  if (!row) throw new Error("Action not found");
  const actor = await canActFor(caller.id, row.identityId, "agents:execute");
  if (!actor.ok) throw new ForbiddenError("Not authorized to read this action.");
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    action: row.action,
    amountUsdc: row.amountUsdc,
    amountBaseUnits: row.amountMicros?.toString() ?? null,
    to: row.counterparty,
    asset: row.asset,
    decision: row.decision,
    ruleId: row.ruleId,
    reason: row.reason,
    status: (row.status ?? (row.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED")) as ExecutionStatus,
    proofHash: row.proofHash,
    complianceRef: row.complianceRef,
    travelRuleRef: row.travelRuleRef,
    actionHash: hashActionId(row.id),
    policyVersion: row.policyVersion,
    receipt: {
      mode: row.receiptMode ?? "mock",
      anchorStatus: row.anchorStatus,
      chainId: row.chainId,
      txHash: row.txHash,
      transferTxHash: row.transferTxHash,
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      logIndex: row.logIndex,
    },
    error: row.errorClass ? { class: row.errorClass, detail: row.errorDetail } : null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

/** keccak256 of the action id, the same actionHash the registries and the guard use. */
function hashActionId(id: string): Hex {
  return hashString(id);
}

/** The stored Travel Rule record of an action, for callers who may execute for its agent. */
export async function getTravelRule(caller: Identity, actionId: string) {
  const row = await db.agentAction.findUnique({ where: { id: actionId }, select: { identityId: true, travelRule: true, travelRuleRef: true } });
  if (!row || !row.travelRule) throw new Error("Travel Rule record not found");
  const actor = await canActFor(caller.id, row.identityId, "agents:execute");
  if (!actor.ok) throw new ForbiddenError("Not authorized to read this record.");
  return { record: JSON.parse(row.travelRule) as unknown, ref: row.travelRuleRef };
}
