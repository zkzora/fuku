import { db } from "../db";

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
  trustDelta: number;
  explanation: string | null;
  /** Set when an orchestrator (e.g. "chainlink-cre") submitted the action through the public API. */
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
