import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { scoreFor, countEvents } from "@/lib/services/agents";
import { apassEligibleFor } from "@/lib/services/cleanverse";
import { rateLimit } from "@/lib/rate-limit";
import { explainScore } from "@/lib/engine/explain";

type P = { id: string };

/** SDK: fuku.getTrustScore() — score, level, breakdown and a plain-language explanation. */
export const GET = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("read", caller.id);
  const agent = await db.agent.findUnique({
    where: { id },
    include: { policy: true, identity: true, reputationEvents: { orderBy: { createdAt: "desc" } } },
  });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const result = scoreFor(agent, agent.identity, agent.reputationEvents, { apassEligible: await apassEligibleFor(agent.identity) });
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
    scoringVersion: result.scoringVersion,
    dimensions: result.dimensions,
    evidence: result.evidence,
    uncertainty: result.uncertainty,
    counts: countEvents(agent.reputationEvents),
    explanation: explanation?.text ?? null,
    explanationProvider: explanation?.provider ?? null,
    updatedAt: agent.updatedAt.toISOString(),
  });
}, { agentKey: { scope: "agent:read", agentParam: "id" } });
