import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { scoreFor, toAgentView } from "@/lib/services/agents";
import { chainStatus } from "@/lib/chain";
import { idToBytes32 } from "@/lib/ids";

type P = { id: string };

/**
 * SDK: fuku.verifyAgent()
 * Public verification: any application holding an API key can ask who is behind an agent,
 * whether that human is verified, and what the agent's current trust score is.
 */
export const GET = withApiKey<P>(async (_req, _caller, { id }) => {
  const agent = await db.agent.findUnique({
    where: { id },
    include: { policy: true, identity: true, reputationEvents: { select: { kind: true } } },
  });
  if (!agent) return json({ verified: false, error: "Agent not found" }, { status: 404 });
  const score = scoreFor(agent, agent.identity, agent.reputationEvents);
  const view = toAgentView({ ...agent, trustScore: score.score });
  return json({
    verified: true,
    agent: {
      id: view.id,
      onChainId: idToBytes32(view.id),
      name: view.name,
      version: view.version,
      status: view.status,
      capabilities: view.capabilities,
      registeredTx: view.registeredTx,
      createdAt: view.createdAt,
    },
    owner: {
      id: agent.identity.id,
      onChainId: idToBytes32(agent.identity.id),
      displayName: agent.identity.displayName,
      humanVerified: agent.identity.humanVerified,
      authMethod: agent.identity.authMethod,
    },
    passport: view.policy
      ? { active: view.policy.active, version: view.policy.version, allowed: view.policy.allowed, blocked: view.policy.blocked, scopeApps: view.policy.scopeApps }
      : null,
    trust: { score: score.score, level: score.level },
    chain: chainStatus().mode,
  });
});
