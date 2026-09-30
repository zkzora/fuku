import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authorizedAgent } from "@/lib/services/authz";
import { revokeAgentPolicy, setAgentPolicy, toAgentView } from "@/lib/services/agents";

type P = { id: string };

/** SDK: fuku.requestPermission() — sets the agent's permission passport (owner, or a delegate with agents:manage). */
export const PUT = withApiKey<P>(async (req, identity, { id }) => {
  rateLimit("manage", identity.id);
  await authorizedAgent(identity, id, "agents:manage");
  const result = await setAgentPolicy(id, await req.json());
  const updated = await db.agent.findUniqueOrThrow({ where: { id }, include: { policy: true } });
  return json({ agent: toAgentView({ ...updated, trustScore: result.score.score }), receipt: result.receipt });
});

export const DELETE = withApiKey<P>(async (_req, identity, { id }) => {
  rateLimit("manage", identity.id);
  await authorizedAgent(identity, id, "agents:manage");
  const { score, chainSync } = await revokeAgentPolicy(id);
  return json({ ok: true, score: score.score, chainSync });
});
