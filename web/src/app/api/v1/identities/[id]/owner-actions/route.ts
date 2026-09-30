import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { requireActFor } from "@/lib/services/authz";
import { confirmOwnerAction, pendingOwnerActions } from "@/lib/services/owner-actions";

type P = { id: string };

/**
 * SDK / scripts: the owner-signed registry writes of an owner-controlled identity. Fuku prepares
 * calldata and confirms mined transactions; it never signs them. Caller: the identity itself, or an
 * identity that may manage it (managed identity or agents:manage delegation).
 */
const body = z.object({
  op: z.enum(["registerIdentity", "registerAgent", "setPolicy", "revokePolicy", "setStatus"]),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  agentId: z.string().optional().nullable(),
});

export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  await requireActFor(caller, id, "agents:manage");
  const identity = await db.identity.findUniqueOrThrow({ where: { id } });
  return json(await pendingOwnerActions(identity));
});

export const POST = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  await requireActFor(caller, id, "agents:manage");
  const input = body.parse(await req.json());
  const identity = await db.identity.findUniqueOrThrow({ where: { id } });
  return json(await confirmOwnerAction(identity, { op: input.op, txHash: input.txHash as `0x${string}`, agentId: input.agentId }));
});
