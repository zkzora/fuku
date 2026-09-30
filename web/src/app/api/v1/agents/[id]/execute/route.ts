import { z } from "zod";
import { json, withApiKey } from "@/lib/api";
import { executeAction } from "@/lib/services/actions";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * SDK: fuku.executeAction() — runs the full workflow: evaluate the passport, execute or block,
 * anchor the proof on Monad, update reputation and explain the outcome.
 */
export const POST = withApiKey<P>(async (req, identity, { id }) => {
  const input = body.parse(await req.json());
  const result = await executeAction({ identityId: identity.id, agentId: id, ...input });
  return json(result, { status: result.decision === "ALLOWED" ? 200 : 403 });
});
