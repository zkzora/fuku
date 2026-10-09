import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { AGENT_KEY_SCOPES } from "@/lib/services/api-keys";

/**
 * SDK: fuku.keyInfo() — what the presented key may do. An owner key acts as its identity on every
 * v1 route; an agent key only for its agent, with its scopes (lib/services/api-keys.ts). The Fuku
 * MCP server checks this before it acts and refuses an owner key unless told otherwise.
 */
export const GET = withApiKey(async (_req, identity, _params, principal) => {
  rateLimit("read", identity.id);
  const key = principal.keyId ? await db.apiKey.findUnique({ where: { id: principal.keyId }, select: { name: true, prefix: true } }) : null;
  return json({
    kind: principal.kind === "agent" ? "agent" : principal.keyId ? "owner" : "session",
    key,
    owner: { id: identity.id, displayName: identity.displayName },
    agentId: principal.kind === "agent" ? principal.agentId : null,
    scopes: principal.kind === "agent" ? principal.scopes : null,
    knownScopes: AGENT_KEY_SCOPES,
  });
}, { agentKey: { scope: null } });
