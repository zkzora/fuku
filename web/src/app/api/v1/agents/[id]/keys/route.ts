import { z } from "zod";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { AGENT_KEY_SCOPES, createAgentApiKey, listAgentApiKeys } from "@/lib/services/api-keys";

type P = { id: string };

const body = z.object({
  name: z.string().trim().min(1).max(60),
  scopes: z.array(z.enum(AGENT_KEY_SCOPES)).min(1).optional(),
});

/**
 * SDK: fuku.listAgentKeys() / fuku.createAgentKey() — API keys bound to this agent
 * (lib/services/api-keys.ts), for software that acts as the agent and must not hold the owner's key.
 * Owner only: delegates and agent keys are refused. The raw key is returned once, at creation.
 */
export const GET = withApiKey<P>(async (_req, owner, { id }) => {
  rateLimit("read", owner.id);
  return json({ keys: await listAgentApiKeys(owner, id) });
});

export const POST = withApiKey<P>(async (req, owner, { id }) => {
  rateLimit("manage", owner.id);
  const input = body.parse(await req.json());
  const { key, raw } = await createAgentApiKey(owner, { agentId: id, name: input.name, scopes: input.scopes });
  return json({ key, raw }, { status: 201 });
});
