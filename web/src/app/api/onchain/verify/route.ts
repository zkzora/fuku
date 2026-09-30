import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { verifyDecisionTx } from "@/lib/integrations/envio";

const body = z.object({ actionId: z.string().min(1) });

/** Verify one ledger decision against Monad through Envio HyperRPC. */
export const POST = withSession(async (req, identity) => {
  const { actionId } = body.parse(await req.json());
  const action = await db.agentAction.findFirst({ where: { id: actionId, identityId: identity.id } });
  if (!action) return json({ error: "Action not found" }, { status: 404 });
  if (!action.txHash) return json({ error: "This action has no transaction hash yet" }, { status: 400 });
  try {
    return json(await verifyDecisionTx(action.txHash, action.proofHash));
  } catch (err) {
    return json({ error: (err as Error).message }, { status: 503 });
  }
});
