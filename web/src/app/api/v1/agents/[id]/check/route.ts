import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { evaluate } from "@/lib/engine/permission";
import { parsePolicy } from "@/lib/engine/policy";
import { spentTodayUsdc } from "@/lib/services/agents";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().optional().nullable(),
  app: z.string().max(60).optional().nullable(),
});

/**
 * SDK: fuku.checkPermission() — dry-run evaluation. Nothing is recorded or anchored, so an
 * application can ask "would this be allowed?" before handing work to an agent.
 */
export const POST = withApiKey<P>(async (req, _caller, { id }) => {
  const input = body.parse(await req.json());
  const agent = await db.agent.findUnique({ where: { id }, include: { policy: true } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const evaluation = evaluate({
    agentStatus: agent.status,
    policy: parsePolicy(agent.policy),
    policyActive: Boolean(agent.policy?.active),
    action: input.action,
    amountUsdc: input.amountUsdc,
    app: input.app,
    spentTodayUsdc: await spentTodayUsdc(agent.id, input.action),
  });
  return json({ agentId: agent.id, allowed: evaluation.decision === "ALLOWED", ...evaluation });
});
