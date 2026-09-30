import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { listAgents, registerAgent } from "@/lib/services/agents";

/** SDK: fuku.registerAgent() — registers an agent under the key owner (or a given owner identity). */
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
  const input = body.parse(await req.json());
  const owner = input.ownerIdentityId
    ? await db.identity.findUniqueOrThrow({ where: { id: input.ownerIdentityId } })
    : identity;
  const result = await registerAgent(owner, input);
  return json(result, { status: 201 });
});
