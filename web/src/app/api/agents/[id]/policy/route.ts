import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { revokeAgentPolicy, setAgentPolicy, toAgentView } from "@/lib/services/agents";

type P = { id: string };

async function ownedAgent(id: string, identityId: string) {
  const agent = await db.agent.findFirst({ where: { id, identityId }, include: { policy: true } });
  if (!agent) throw new Error("Agent not found");
  return agent;
}

export const GET = withSession<P>(async (_req, identity, { id }) => {
  const agent = await ownedAgent(id, identity.id);
  return json({ policy: toAgentView(agent).policy });
});

export const PUT = withSession<P>(async (req, identity, { id }) => {
  rateLimit("manage", identity.id);
  await ownedAgent(id, identity.id);
  const result = await setAgentPolicy(id, await req.json());
  const agent = await ownedAgent(id, identity.id);
  return json({ agent: toAgentView({ ...agent, trustScore: result.score.score }), receipt: result.receipt });
});

export const DELETE = withSession<P>(async (_req, identity, { id }) => {
  rateLimit("manage", identity.id);
  await ownedAgent(id, identity.id);
  const { score, chainSync } = await revokeAgentPolicy(id);
  return json({ ok: true, score: score.score, chainSync });
});
