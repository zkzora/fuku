import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { confirmOwnerAction, pendingOwnerActions } from "@/lib/services/owner-actions";

/**
 * Owner-signed registry writes for the signed-in identity (owner custody, lib/custody.ts).
 *   GET  -> custody, controller and the transactions the owner's wallet still has to send
 *   POST { op, txHash, agentId? } -> confirm one after it was mined (receipt, sender, event)
 */
const body = z.object({
  op: z.enum(["registerIdentity", "registerAgent", "setPolicy", "revokePolicy", "setStatus"]),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  agentId: z.string().optional().nullable(),
});

export const GET = withSession(async (_req, identity) => {
  rateLimit("read", identity.id);
  return json(await pendingOwnerActions(identity));
});

export const POST = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  const input = body.parse(await req.json());
  return json(await confirmOwnerAction(identity, { op: input.op, txHash: input.txHash as `0x${string}`, agentId: input.agentId }));
});
