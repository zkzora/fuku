import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { executeAction } from "@/lib/services/actions";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  // Validated by the engine (R8 CVI_NOT_FOUND), not here, so a bad address is a recorded decision.
  to: z.string().max(100).optional().nullable(),
  asset: z.string().max(32).optional().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withSession<P>(async (req, identity, { id }) => {
  const input = body.parse(await req.json());
  const result = await executeAction({ identityId: identity.id, agentId: id, ...input });
  return json(result, { status: result.decision === "ALLOWED" ? 200 : 403 });
});
