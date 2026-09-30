import type { Prisma } from "@prisma/client";
import type { Hex } from "viem";
import { db } from "../db";
import {
  anchorStateOf,
  ATTESTATION_TTL_S,
  chainMode,
  findGuardExecution,
  guardActionExecuted,
  latestBlock,
  recordDecisionOnChain,
  toAgentRef,
  transactionOutcome,
  updateScoreOnChain,
} from "../chain";
import { hashString } from "../ids";
import { labelFor } from "../engine/policy";
import { utcDayKey } from "../engine/permission";
import { refreshScore, scoreAgent } from "./agents";
import { releaseBudget } from "./budget";

/**
 * Settles what an interrupted, timed-out or re-organised execution left behind. Idempotent and safe
 * to run from several processes: every transition is a conditional update on the row's current
 * status, reputation events are unique per action, and the guard's single-use action hash means a
 * transfer can never execute twice.
 *
 *   SUBMITTED / PENDING  -> CONFIRMED (receipt success) | FAILED (reverted, or never executed and
 *                           its attestation expired) | unchanged (still in flight)
 *   AUTHORIZED transfer  -> the process died before persisting the hash: the guard's
 *                           actionExecuted(actionHash) decides, and the log is found by event
 *   CONFIRMED (recent)   -> PENDING again if the receipt disappeared (reorg); its success event is
 *                           removed until it confirms again
 *   anchorStatus failed  -> the decision anchor is sent again; pending anchors are checked first
 */
const REORG_DEPTH = BigInt(Number(process.env.FUKU_REORG_DEPTH ?? 64));
const LOG_LOOKBACK = BigInt(Number(process.env.FUKU_LOG_LOOKBACK ?? 20_000));
/** A transfer that has not executed this long after its attestation was signed never will. */
const EXPIRY_MARGIN_MS = (ATTESTATION_TTL_S + 60) * 1000;

export interface ReconcileReport {
  checked: number;
  confirmed: number;
  failed: number;
  reorged: number;
  anchored: number;
  skipped?: string;
}

type Row = Prisma.AgentActionGetPayload<{ include: { agent: { include: { policy: true; identity: true } } } }>;

export async function reconcile(opts: { agentId?: string; identityId?: string; actionId?: string; limit?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, confirmed: 0, failed: 0, reorged: 0, anchored: 0 };
  if (chainMode() !== "live") return { ...report, skipped: "mock chain" };
  const head = await latestBlock();
  if (head === null) return { ...report, skipped: "no chain reader" };
  const scope: Prisma.AgentActionWhereInput = {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.identityId ? { identityId: opts.identityId } : {}),
    ...(opts.actionId ? { id: opts.actionId } : {}),
  };
  const take = opts.limit ?? 25;
  const include = { agent: { include: { policy: true, identity: true } } } as const;

  // 1. transfers in flight, and allowed A-Token transfers that never recorded a broadcast
  const inFlight = await db.agentAction.findMany({
    where: {
      ...scope,
      OR: [{ status: { in: ["SUBMITTED", "PENDING"] } }, { status: "AUTHORIZED", complianceRef: { not: null }, action: "transfer" }],
    },
    include,
    orderBy: { createdAt: "asc" },
    take,
  });
  for (const row of inFlight) {
    report.checked++;
    const r = await settleTransfer(row, head);
    if (r === "confirmed") report.confirmed++;
    if (r === "failed") report.failed++;
  }

  // 2. recently confirmed transfers: still in the canonical chain?
  const recent = await db.agentAction.findMany({
    where: { ...scope, status: "CONFIRMED", transferTxHash: { not: null }, blockNumber: { gte: Number(head > REORG_DEPTH ? head - REORG_DEPTH : BigInt(0)) } },
    include,
    take,
  });
  for (const row of recent) {
    report.checked++;
    const out = await transactionOutcome(row.transferTxHash as Hex, hashString(row.id));
    if (!out) continue;
    if (!out.found || !out.success) {
      await unconfirm(row);
      report.reorged++;
    } else if (out.blockHash !== row.blockHash) {
      await db.agentAction.update({ where: { id: row.id }, data: { blockNumber: out.block, blockHash: out.blockHash, logIndex: out.logIndex, lastCheckedAt: new Date() } });
    }
  }

  // 3. decision anchors that failed or are pending
  const anchors = await db.agentAction.findMany({
    where: { ...scope, anchorStatus: { in: ["failed", "pending"] }, NOT: { status: { in: ["SUBMITTED", "PENDING", "CONFIRMED"] } } },
    include,
    take,
  });
  for (const row of anchors) {
    report.checked++;
    if (row.anchorStatus === "pending" && row.txHash) {
      const out = await transactionOutcome(row.txHash as Hex);
      if (out?.found) {
        await db.agentAction.updateMany({
          where: { id: row.id, anchorStatus: "pending" },
          data: out.success ? { anchorStatus: "anchored", blockNumber: out.block, lastCheckedAt: new Date() } : { anchorStatus: "failed", txHash: null, lastCheckedAt: new Date() },
        });
        if (out.success) report.anchored++;
      }
      continue;
    }
    const receipt = await recordDecisionOnChain({
      agent: toAgentRef(row.agent, row.agent.identity),
      actionId: row.id,
      allowed: row.decision === "ALLOWED",
      proofHash: row.proofHash as Hex,
      ruleId: row.ruleId ?? (row.decision === "ALLOWED" ? "R6" : "R1"),
    });
    await db.agentAction.update({
      where: { id: row.id },
      data: { anchorStatus: anchorStateOf(receipt), txHash: receipt.txHash, receiptMode: receipt.mode, chainId: receipt.chainId, blockNumber: receipt.block, lastCheckedAt: new Date() },
    });
    if (receipt.status === "confirmed") report.anchored++;
  }
  return report;
}

async function settleTransfer(row: Row, head: bigint): Promise<"confirmed" | "failed" | "unchanged"> {
  const actionHash = hashString(row.id);
  const expired = Date.now() - (row.submittedAt ?? row.createdAt).getTime() > EXPIRY_MARGIN_MS;
  if (row.transferTxHash) {
    const out = await transactionOutcome(row.transferTxHash as Hex, actionHash);
    if (out?.found && out.success) return confirm(row, { txHash: row.transferTxHash as Hex, block: out.block, blockHash: out.blockHash, logIndex: out.logIndex });
    if (out?.found && !out.success) return fail(row, "reverted", `mined and reverted (tx ${row.transferTxHash})`);
  }
  // No receipt (or no stored hash): did the guard execute this action at all?
  const executed = await guardActionExecuted(row.id);
  if (executed) {
    const hit = await findGuardExecution(row.agentId, row.id, head > LOG_LOOKBACK ? head - LOG_LOOKBACK : BigInt(0));
    if (hit) return confirm(row, { txHash: hit.txHash, block: Number(hit.block), blockHash: hit.blockHash, logIndex: hit.logIndex });
    return "unchanged"; // executed, log outside the lookback window: leave for a wider scan
  }
  if (executed === false && expired) return fail(row, "expired", "never executed and the attestation has expired; nothing moved");
  await db.agentAction.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } });
  return "unchanged";
}

async function confirm(row: Row, at: { txHash: Hex; block: number; blockHash: Hex; logIndex: number | null }): Promise<"confirmed" | "unchanged"> {
  const moved = await db.agentAction.updateMany({
    where: { id: row.id, status: { in: ["SUBMITTED", "PENDING", "AUTHORIZED"] } },
    data: {
      status: "CONFIRMED",
      transferTxHash: at.txHash,
      txHash: at.txHash,
      receiptMode: "live",
      blockNumber: at.block,
      blockHash: at.blockHash,
      logIndex: at.logIndex,
      anchorStatus: "anchored",
      errorClass: null,
      settledAt: new Date(),
      lastCheckedAt: new Date(),
    },
  });
  if (moved.count !== 1) return "unchanged";
  await award(row, "success", `Executed: ${labelFor(row.action)} ${row.amountUsdc ?? ""} (tx ${at.txHash.slice(0, 10)}…, reconciled)`);
  return "confirmed";
}

async function fail(row: Row, errorClass: string, detail: string): Promise<"failed" | "unchanged"> {
  const moved = await db.agentAction.updateMany({
    where: { id: row.id, status: { in: ["SUBMITTED", "PENDING", "AUTHORIZED"] } },
    data: { status: "FAILED", errorClass, errorDetail: detail, settledAt: new Date(), lastCheckedAt: new Date() },
  });
  if (moved.count !== 1) return "unchanged";
  if (row.amountMicros !== null) await releaseBudget(row.agentId, row.action, row.amountMicros, utcDayKey(row.createdAt));
  return "failed";
}

/** A confirmed transfer whose receipt disappeared: back to PENDING, and its success no longer counts. */
async function unconfirm(row: Row) {
  const moved = await db.agentAction.updateMany({
    where: { id: row.id, status: "CONFIRMED" },
    data: { status: "PENDING", blockHash: null, logIndex: null, anchorStatus: "pending", lastCheckedAt: new Date() },
  });
  if (moved.count !== 1) return;
  const removed = await db.reputationEvent.deleteMany({ where: { actionId: row.id, kind: "success" } });
  if (removed.count > 0) await rescore(row, "REORG");
}

async function award(row: Row, kind: "success", note: string) {
  try {
    await db.reputationEvent.create({ data: { agentId: row.agentId, actionId: row.id, kind, delta: 0, note } });
  } catch {
    return; // already awarded for this action (unique actionId)
  }
  await rescore(row, "CONFIRMED:R6");
}

async function rescore(row: Row, reason: string) {
  const before = row.agent.trustScore ?? (await scoreAgent(row.agentId)).score;
  const after = await refreshScore(row.agentId);
  const delta = after.score - before;
  await db.reputationEvent.updateMany({ where: { actionId: row.id }, data: { delta } });
  if (delta !== 0) await updateScoreOnChain(toAgentRef(row.agent, row.agent.identity), after.score, delta, reason);
}

/** Best-effort, throttled reconcile for request paths (at most once per 15 s per scope per process). */
const lastRun = new Map<string, number>();
export async function reconcileSoon(scope: { identityId?: string; agentId?: string }) {
  const key = scope.identityId ?? scope.agentId ?? "all";
  const now = Date.now();
  if ((lastRun.get(key) ?? 0) > now - 15_000) return;
  lastRun.set(key, now);
  try {
    await reconcile({ ...scope, limit: 10 });
  } catch (err) {
    console.warn(`[fuku-reconcile] ${(err as Error).message}`);
  }
}
