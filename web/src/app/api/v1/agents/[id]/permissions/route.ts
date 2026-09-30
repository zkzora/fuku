import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { revokeAgentPolicy, setAgentPolicy, toAgentView } from "@/lib/services/agents";

type P = { id: string };

/** SDK: fuku.requestPermission() — sets the agent's permission passport (owner only). */
export const PUT = withApiKey<P>(async (req, identity, { id }) => {
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found for this identity" }, { status: 404 });
  const result = await setAgentPolicy(id, await req.json());
  const updated = await db.agent.findUniqueOrThrow({ where: { id }, include: { policy: true } });
  return json({ agent: toAgentView({ ...updated, trustScore: result.score.score }), receipt: result.receipt });
});

export const DELETE = withApiKey<P>(async (_req, identity, { id }) => {
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found for this identity" }, { status: 404 });
  const { score, chainSync } = await revokeAgentPolicy(id);
  return json({ ok: true, score: score.score, chainSync });
});
