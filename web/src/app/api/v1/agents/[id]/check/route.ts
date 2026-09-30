import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { assessAction, complianceView } from "@/lib/services/actions";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  to: z.string().max(100).optional().nullable(),
  asset: z.string().max(32).optional().nullable(),
});

/**
 * SDK: fuku.checkPermission() — dry-run evaluation. Nothing is recorded, anchored or signed, so an
 * application can ask "would this be allowed?" before handing work to an agent. For a transfer on
 * an A-Token passport the Cleanverse evidence is gathered and returned as well.
 */
export const POST = withApiKey<P>(async (req, _caller, { id }) => {
  const input = body.parse(await req.json());
  const agent = await db.agent.findUnique({ where: { id }, include: { policy: true, identity: true } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const { evaluation, compliance } = await assessAction(agent, input);
  return json({
    agentId: agent.id,
    allowed: evaluation.decision === "ALLOWED",
    ...evaluation,
    subCode: evaluation.subCode ?? null,
    compliance: complianceView(compliance),
  });
});
