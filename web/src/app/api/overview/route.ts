import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { listAgents } from "@/lib/services/agents";
import { listActivity } from "@/lib/services/activity";
import { levelFor } from "@/lib/engine/reputation";

export const GET = withSession(async (_req, identity) => {
  const [agents, activity, pendingRequests, passkeys] = await Promise.all([
    listAgents(identity.id),
    listActivity(identity.id, { limit: 6 }),
    db.accessRequest.count({ where: { identityId: identity.id, status: "pending" } }),
    db.passkey.findMany({ where: { identityId: identity.id }, select: { label: true, deviceType: true } }),
  ]);
  const scored = agents.filter((a) => a.trustScore !== null);
  const primary = scored.sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0))[0] ?? null;
  const overall = scored.length
    ? Math.round(scored.reduce((s, a) => s + (a.trustScore ?? 0), 0) / scored.length)
    : null;
  return json({
    identity,
    passkeys,
    agents,
    activity,
    pendingRequests,
    trust: {
      overall,
      level: primary?.trustScore == null ? null : levelFor(primary.trustScore),
      primaryAgentId: primary?.id ?? null,
      primaryScore: primary?.trustScore ?? null,
    },
  });
});
