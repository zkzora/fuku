import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { fetchRegistryEvents } from "@/lib/integrations/envio";

/**
 * On-chain history of the signed-in identity and its agents, indexed by Envio HyperSync from the
 * Fuku registries on Monad. `?agentId=` narrows it to one agent.
 */
export const GET = withSession(async (req, identity) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 100));
  const agents = await db.agent.findMany({ where: { identityId: identity.id }, select: { id: true, name: true } });

  const names: Record<string, string> = { [identity.id]: identity.displayName };
  for (const a of agents) names[a.id] = a.name;
  const subjects = agentId ? agents.filter((a) => a.id === agentId).map((a) => a.id) : [identity.id, ...agents.map((a) => a.id)];
  if (subjects.length === 0) return json({ error: "Agent not found" }, { status: 404 });

  try {
    const feed = await fetchRegistryEvents({ subjects, names, limit });
    return json(feed);
  } catch (err) {
    return json({ error: (err as Error).message }, { status: 503 });
  }
});
