import { z } from "zod";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { executeAction, httpStatusOf } from "@/lib/services/actions";

type P = { id: string };

const body = z.object({
  action: z.string().min(1).max(40),
  amountUsdc: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  app: z.string().max(60).optional().nullable(),
  to: z.string().max(100).optional().nullable(),
  asset: z.string().max(32).optional().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

/**
 * SDK: fuku.executeAction() — authorize the caller (owner, managed identity or delegation with
 * agents:execute), evaluate the passport, execute or block, anchor the proof on Monad, update
 * reputation and explain the outcome. Send an Idempotency-Key header to make retries safe: the same
 * key replays the stored result instead of executing again.
 * 200 allowed (AUTHORIZED / CONFIRMED / SIMULATED), 202 broadcast but pending, 403 blocked.
 */
export const POST = withApiKey<P>(async (req, identity, { id }) => {
  rateLimit("execute", identity.id);
  const input = body.parse(await req.json());
  const idempotencyKey = req.headers.get("idempotency-key") ?? input.idempotencyKey ?? null;
  const result = await executeAction({ ...input, callerId: identity.id, agentId: id, idempotencyKey });
  return json(result, { status: httpStatusOf(result) });
});
