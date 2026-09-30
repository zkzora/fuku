import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { executeAction, httpStatusOf } from "@/lib/services/actions";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  // Validated by the engine (R12 / R8), not here, so a bad address is a recorded decision.
  to: z.string().max(100).optional().nullable(),
  asset: z.string().max(32).optional().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const POST = withSession<P>(async (req, identity, { id }) => {
  rateLimit("execute", identity.id);
  const input = body.parse(await req.json());
  const idempotencyKey = req.headers.get("idempotency-key") ?? input.idempotencyKey ?? null;
  const result = await executeAction({ ...input, callerId: identity.id, agentId: id, idempotencyKey });
  return json(result, { status: httpStatusOf(result) });
});
