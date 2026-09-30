import type { Prisma } from "@prisma/client";
import { getAddress, isAddress, parseAbiItem, type Address, type Hex } from "viem";
import { db } from "../db";
import {
  anchorStateOf,
  attestationTtlSeconds,
  bumpWalletValidAfterOnChain,
  chainMode,
  chainReader,
  findGuardExecution,
  guardActionExecuted,
  latestBlock,
  logChunkSize,
  recordDecisionOnChain,
  spendGuardAddress,
  toAgentRef,
  transactionOutcome,
  updateScoreOnChain,
} from "../chain";
import { hashString } from "../ids";
import { isATokenPassport, labelFor, parsePolicy } from "../engine/policy";
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
 *   allowance changed    -> an Approval from an owner wallet to FukuSpendGuard bumps that wallet's
 *                           validAfter, so an allowance withdrawn and restored cannot revive earlier
 *                           attestations (the owner's own bumpWalletValidAfter is the immediate path)
 */
const REORG_DEPTH = BigInt(Number(process.env.FUKU_REORG_DEPTH ?? 64));
const LOG_LOOKBACK = BigInt(Number(process.env.FUKU_LOG_LOOKBACK ?? 20_000));
/** A transfer that has not executed this long after its attestation was signed never will. */
const EXPIRY_MARGIN_MS = (attestationTtlSeconds() + 60) * 1000;

export interface ReconcileReport {
  checked: number;
  confirmed: number;
  failed: number;
  reorged: number;
  anchored: number;
  /** Wallet validAfter bumps sent because an allowance to the guard changed. */
  bumped: number;
  skipped?: string;
}

type Row = Prisma.AgentActionGetPayload<{ include: { agent: { include: { policy: true; identity: true } } } }>;

export async function reconcile(opts: { agentId?: string; identityId?: string; actionId?: string; limit?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, confirmed: 0, failed: 0, reorged: 0, anchored: 0, bumped: 0 };
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
    // awaiting-owner: an owner-controlled agent that was not registered yet; retried at no cost (no tx
    // is sent until the owner has registered it).
    where: { ...scope, anchorStatus: { in: ["failed", "pending", "awaiting-owner"] }, NOT: { status: { in: ["SUBMITTED", "PENDING", "CONFIRMED"] } } },
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

  // 4. allowance changes to the guard
  report.bumped = await watchAllowances(opts.identityId, head);
  return report;
}

const APPROVAL = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
/** A gap longer than this (blocks) is not scanned: the wallet is bumped to be safe. */
const ALLOWANCE_SCAN_MAX = BigInt(Number(process.env.FUKU_ALLOWANCE_SCAN_MAX ?? 2_000));

/**
 * For every owner wallet that funds an A-Token agent: scan the A-Token's Approval events from that
 * wallet to FukuSpendGuard since the last scan, and when there is one (or the gap is too long to scan)
 * bump the wallet's validAfter for each of its A-Token agents. Watching starts at the first run.
 */
async function watchAllowances(identityId: string | undefined, head: bigint): Promise<number> {
  const guard = spendGuardAddress();
  const token = process.env.CLEANVERSE_ATOKEN_ADDRESS?.trim() || process.env.CLEANVERSE_SIM_ATOKEN?.trim();
  const client = chainReader();
  if (!guard || !token || !isAddress(token) || !client) return 0;
  const owners = await db.identity.findMany({
    where: { ...(identityId ? { id: identityId } : {}), walletVerifiedBy: { not: null }, walletAddress: { not: null } },
    include: { agents: { include: { policy: true } } },
  });
  const span = logChunkSize();
  let bumped = 0;
  for (const owner of owners) {
    const agents = owner.agents.filter((a) => isATokenPassport(parsePolicy(a.policy)));
    if (agents.length === 0 || !isAddress(owner.walletAddress!)) continue;
    const wallet = getAddress(owner.walletAddress!) as Address;
    if (owner.allowanceScanBlock === null) {
      await db.identity.update({ where: { id: owner.id }, data: { allowanceScanBlock: Number(head) } });
      continue;
    }
    const from = BigInt(owner.allowanceScanBlock) + BigInt(1);
    if (from > head) continue;
    let changed = head - from + BigInt(1) > ALLOWANCE_SCAN_MAX;
    for (let lo = from; !changed && lo <= head; lo += span) {
      const hi = lo + span - BigInt(1) > head ? head : lo + span - BigInt(1);
      const logs = await client.getLogs({ address: token as Address, event: APPROVAL, args: { owner: wallet, spender: guard }, fromBlock: lo, toBlock: hi });
      if (logs.length > 0) changed = true;
    }
    if (changed) {
      for (const agent of agents) {
        try {
          if (await bumpWalletValidAfterOnChain(agent.id, wallet)) bumped++;
        } catch (err) {
          console.warn(`[fuku-reconcile] bumpWalletValidAfter(${agent.id}) failed: ${(err as Error).message}`);
        }
      }
    }
    await db.identity.update({ where: { id: owner.id }, data: { allowanceScanBlock: Number(head) } });
  }
  return bumped;
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
