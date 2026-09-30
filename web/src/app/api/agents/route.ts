import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { listAgents, registerAgent } from "@/lib/services/agents";

const body = z.object({
  name: z.string().trim().min(2).max(60),
  version: z.string().trim().max(20).optional(),
  capabilities: z.array(z.string().min(1)).min(1).max(12),
  description: z.string().trim().max(240).optional(),
});

export const GET = withSession(async (_req, identity) => {
  return json({ agents: await listAgents(identity.id) });
});

export const POST = withSession(async (req, identity) => {
  const input = body.parse(await req.json());
  const result = await registerAgent(identity, input);
  return json(result, { status: 201 });
});
