import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { scoreFor, countEvents } from "@/lib/services/agents";
import { explainScore } from "@/lib/engine/explain";

type P = { id: string };

/** SDK: fuku.getTrustScore() — score, level, breakdown and a plain-language explanation. */
export const GET = withApiKey<P>(async (req, _caller, { id }) => {
  const agent = await db.agent.findUnique({
    where: { id },
    include: { policy: true, identity: true, reputationEvents: { orderBy: { createdAt: "desc" } } },
  });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const result = scoreFor(agent, agent.identity, agent.reputationEvents);
  const wantExplanation = new URL(req.url).searchParams.get("explain") !== "0";
  const explanation = wantExplanation
    ? await explainScore({
        agentName: agent.name,
        ownerName: agent.identity.displayName,
        result,
        recentViolation: agent.reputationEvents.find((e) => e.kind === "violation")?.note ?? null,
      })
    : null;
  return json({
    agentId: agent.id,
    score: result.score,
    level: result.level,
    breakdown: result.breakdown,
    counts: countEvents(agent.reputationEvents),
    explanation: explanation?.text ?? null,
    explanationProvider: explanation?.provider ?? null,
    updatedAt: agent.updatedAt.toISOString(),
  });
});
