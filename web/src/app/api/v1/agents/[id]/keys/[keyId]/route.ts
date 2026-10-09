import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { revokeAgentApiKey } from "@/lib/services/api-keys";

type P = { id: string; keyId: string };

/** SDK: fuku.revokeAgentKey() — the key stops working on the next request. Owner only. */
export const DELETE = withApiKey<P>(async (_req, owner, { id, keyId }) => {
  rateLimit("manage", owner.id);
  await revokeAgentApiKey(owner, id, keyId);
  return json({ ok: true });
});
