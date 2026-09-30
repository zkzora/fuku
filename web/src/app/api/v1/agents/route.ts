import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { listAgents, registerAgent } from "@/lib/services/agents";
import { requireActFor } from "@/lib/services/authz";
import { rateLimit } from "@/lib/rate-limit";

/**
 * SDK: fuku.registerAgent() — registers an agent under the key owner, or under `ownerIdentityId`
 * when the caller may act for that owner (an identity it created for one of its users, or an
 * explicit delegation with agents:register). Anything else is 403.
 */
const body = z.object({
  name: z.string().trim().min(2).max(60),
  version: z.string().trim().max(20).optional(),
  capabilities: z.array(z.string().min(1)).min(1).max(12),
  description: z.string().trim().max(240).optional(),
  ownerIdentityId: z.string().optional(),
});

export const GET = withApiKey(async (_req, identity) => {
  return json({ agents: await listAgents(identity.id) });
});

export const POST = withApiKey(async (req, identity) => {
  rateLimit("create", identity.id);
  const input = body.parse(await req.json());
  let owner = identity;
  if (input.ownerIdentityId && input.ownerIdentityId !== identity.id) {
    await requireActFor(identity, input.ownerIdentityId, "agents:register");
    owner = await db.identity.findUniqueOrThrow({ where: { id: input.ownerIdentityId } });
  }
  const result = await registerAgent(owner, input);
  return json(result, { status: 201 });
});
