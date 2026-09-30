import { db } from "../db";
import type { ExecutionStatus } from "./actions";

export interface ActivityItem {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  amountUsdc: number | null;
  app: string | null;
  decision: "ALLOWED" | "BLOCKED";
  reason: string;
  ruleId: string | null;
  proofHash: string;
  txHash: string | null;
  /** Execution lifecycle (legacy rows: AUTHORIZED / DENIED from the decision). */
  status: ExecutionStatus;
  /**
   * How the decision or transfer receipt was produced. "mock" rows never had a real transaction;
   * "unknown" rows predate stored receipt modes (use Verify on-chain to check them).
   */
  receiptMode: "live" | "mock" | "unknown";
  /** Decision anchoring: anchored | mock | pending | failed (null for guard-recorded transfers). */
  anchorStatus: string | null;
  chainId: number | null;
  transferTxHash: string | null;
  counterparty: string | null;
  asset: string | null;
  trustDelta: number;
  explanation: string | null;
  /** A label the caller put in `params.orchestrator` (e.g. "chainlink-cre"). Declared, not verified. */
  orchestrator: string | null;
  createdAt: string;
}

export async function listActivity(
  identityId: string,
  opts: { agentId?: string; limit?: number; decision?: "ALLOWED" | "BLOCKED" } = {},
): Promise<ActivityItem[]> {
  const rows = await db.agentAction.findMany({
    where: { identityId, agentId: opts.agentId, decision: opts.decision },
    include: { agent: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agent.name,
    action: r.action,
    amountUsdc: r.amountUsdc,
    app: r.app,
    decision: r.decision as "ALLOWED" | "BLOCKED",
    reason: r.reason,
    ruleId: r.ruleId,
    proofHash: r.proofHash,
    txHash: r.txHash,
    status: (r.status ?? (r.decision === "ALLOWED" ? "AUTHORIZED" : "DENIED")) as ExecutionStatus,
    receiptMode: r.receiptMode === "live" || r.receiptMode === "mock" ? r.receiptMode : "unknown",
    anchorStatus: r.anchorStatus,
    chainId: r.chainId,
    transferTxHash: r.transferTxHash,
    counterparty: r.counterparty,
    asset: r.asset,
    trustDelta: r.trustDelta,
    explanation: r.explanation,
    orchestrator: orchestratorOf(r.params),
    createdAt: r.createdAt.toISOString(),
  }));
}

function orchestratorOf(params: string | null): string | null {
  if (!params) return null;
  try {
    const p = JSON.parse(params) as { orchestrator?: unknown };
    return typeof p.orchestrator === "string" ? p.orchestrator : null;
  } catch {
    return null;
  }
}
