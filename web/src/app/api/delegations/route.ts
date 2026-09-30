import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { grantDelegation, listDelegations, SCOPES } from "@/lib/services/authz";

/**
 * Owner-side delegation management (session only: an API key can never grant itself rights).
 *   GET  -> delegations granted and received
 *   POST { delegateId, scopes, expiresInDays? } -> a new grant
 */
const body = z.object({
  delegateId: z.string().min(1),
  scopes: z.array(z.enum(SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const GET = withSession(async (_req, identity) => json({ delegations: await listDelegations(identity) }));

export const POST = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  const input = body.parse(await req.json());
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const d = await grantDelegation(identity, { delegateId: input.delegateId, scopes: input.scopes, expiresAt });
  return json({ id: d.id, ownerId: d.ownerId, delegateId: d.delegateId, scopes: input.scopes, expiresAt: d.expiresAt }, { status: 201 });
});
