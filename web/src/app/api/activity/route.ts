import { json, withSession } from "@/lib/api";
import { listActivity } from "@/lib/services/activity";

export const GET = withSession(async (req, identity) => {
  const url = new URL(req.url);
  const decision = url.searchParams.get("decision");
  const activity = await listActivity(identity.id, {
    agentId: url.searchParams.get("agentId") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 50),
    decision: decision === "ALLOWED" || decision === "BLOCKED" ? decision : undefined,
  });
  return json({ activity });
});
