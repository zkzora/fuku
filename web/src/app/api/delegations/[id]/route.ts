import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { revokeDelegation } from "@/lib/services/authz";

type P = { id: string };

/** Revoke a delegation this identity granted. Takes effect for the next request. */
export const DELETE = withSession<P>(async (_req, identity, { id }) => {
  rateLimit("manage", identity.id);
  await revokeDelegation(identity, id);
  return json({ ok: true });
});
