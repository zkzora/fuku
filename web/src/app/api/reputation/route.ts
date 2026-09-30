import { json, withSession } from "@/lib/api";
import { listAgents } from "@/lib/services/agents";
import { agentReport } from "@/lib/services/reputation";

export const GET = withSession(async (req, identity) => {
  const agents = await listAgents(identity.id);
  const requested = new URL(req.url).searchParams.get("agentId");
  const selectedId = requested ?? agents.find((a) => a.trustScore !== null)?.id ?? agents[0]?.id ?? null;
  const report = selectedId ? await agentReport(selectedId, identity) : null;
  return json({ agents, report });
});
