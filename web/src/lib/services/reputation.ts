import type { Identity } from "@prisma/client";
import { db } from "../db";
import { explainScore } from "../engine/explain";
import { agentIntelligence } from "../integrations";
import { countEvents, scoreFor, toAgentView } from "./agents";

/** Full reputation report for one agent: score, breakdown, ledger counts, intelligence and explanation. */
export async function agentReport(agentId: string, identity: Identity, withExplanation = true) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, identityId: identity.id },
    include: { policy: true, reputationEvents: { orderBy: { createdAt: "desc" } } },
  });
  if (!agent) throw new Error("Agent not found");
  const result = scoreFor(agent, identity, agent.reputationEvents);
  const counts = countEvents(agent.reputationEvents);
  const lastViolation = agent.reputationEvents.find((e) => e.kind === "violation");
  const [intelligence, explanation] = await Promise.all([
    agentIntelligence({
      walletAddress: identity.walletAddress,
      ...counts,
      ageDays: Math.max(0, Math.round((Date.now() - agent.createdAt.getTime()) / 86_400_000)),
    }),
    withExplanation
      ? explainScore({
          agentName: agent.name,
          ownerName: identity.displayName,
          result,
          recentViolation: lastViolation?.note ?? null,
        })
      : Promise.resolve(null),
  ]);
  return {
    agent: toAgentView({ ...agent, trustScore: result.score }),
    score: result.score,
    level: result.level,
    breakdown: result.breakdown,
    counts,
    intelligence,
    explanation: explanation?.text ?? null,
    explanationProvider: explanation?.provider ?? null,
    events: agent.reputationEvents.slice(0, 20).map((e) => ({
      id: e.id,
      kind: e.kind,
      delta: e.delta,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
