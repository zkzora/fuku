import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { chainStatus } from "@/lib/chain";

export const GET = withSession(async (_req, identity) => {
  const [passkeys, connectedApps, credentials, accessRequests, agentCount] = await Promise.all([
    db.passkey.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "asc" } }),
    db.connectedApp.findMany({ where: { identityId: identity.id }, orderBy: { connectedAt: "desc" } }),
    db.credential.findMany({ where: { identityId: identity.id } }),
    db.accessRequest.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "desc" } }),
    db.agent.count({ where: { identityId: identity.id } }),
  ]);
  return json({
    identity,
    agentCount,
    chain: chainStatus(),
    passkeys: passkeys.map((p) => ({
      id: p.id,
      label: p.label,
      deviceType: p.deviceType,
      backedUp: p.backedUp,
      createdAt: p.createdAt.toISOString(),
    })),
    connectedApps: connectedApps.map((a) => ({ ...a, scopes: JSON.parse(a.scopes) as string[] })),
    credentials,
    accessRequests,
  });
});
