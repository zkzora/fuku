import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { chainStatus } from "@/lib/chain";
import { storedAPass } from "@/lib/services/cleanverse";
import { verificationOf } from "@/lib/services/identity";

export const GET = withSession(async (_req, identity) => {
  const [passkeys, connectedApps, credentials, accessRequests, agentCount, apass, verification] = await Promise.all([
    db.passkey.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "asc" } }),
    db.connectedApp.findMany({ where: { identityId: identity.id }, orderBy: { connectedAt: "desc" } }),
    db.credential.findMany({ where: { identityId: identity.id } }),
    db.accessRequest.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "desc" } }),
    db.agent.count({ where: { identityId: identity.id } }),
    // The A-Pass card reads the owner's wallet only once its binding is verified.
    storedAPass(identity.walletVerifiedBy ? identity.walletAddress : null),
    verificationOf(identity),
  ]);
  return json({
    // The binding proof (message + signature) stays server-side; the statuses summarise it.
    identity: { ...identity, walletProof: undefined },
    verification,
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
    // Last persisted A-Pass read for the owner wallet (no provider call on page load).
    apass,
    accessRequests,
  });
});
