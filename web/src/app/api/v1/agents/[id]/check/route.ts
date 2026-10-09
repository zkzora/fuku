import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { assessAction, complianceView } from "@/lib/services/actions";
import { canActFor } from "@/lib/services/authz";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  to: z.string().max(100).optional().nullable(),
  asset: z.string().max(32).optional().nullable(),
});

/**
 * SDK: fuku.checkPermission() — dry run. Nothing is recorded, anchored, reserved or signed, so an
 * application can ask "would this be allowed right now?" before handing work to an agent. A preview
 * is not an execution. For a transfer on an A-Token passport the Cleanverse legs are returned; the
 * underlying evidence (owner wallet, record ids, tiers) only to callers who may execute for the
 * agent (the owner or a delegate).
 */
export const POST = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("read", caller.id);
  const input = body.parse(await req.json());
  const agent = await db.agent.findUnique({ where: { id }, include: { policy: true, identity: true } });
  if (!agent) return json({ error: "Agent not found", code: "not_found" }, { status: 404 });
  const { evaluation, compliance } = await assessAction(agent, input);
  const privileged = (await canActFor(caller.id, agent.identityId, "agents:execute")).ok;
  const view = complianceView(compliance);
  return json({
    agentId: agent.id,
    preview: true,
    allowed: evaluation.decision === "ALLOWED",
    ...evaluation,
    subCode: evaluation.subCode ?? null,
    compliance: view && !privileged ? { ...view, evidence: null } : view,
  });
}, { agentKey: { scope: "agent:check", agentParam: "id" } });
