import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { agentReport } from "@/lib/services/reputation";
import { setAgentStatus } from "@/lib/services/agents";
import { listActivity } from "@/lib/services/activity";

type P = { id: string };

export const GET = withSession<P>(async (req, identity, { id }) => {
  const explain = new URL(req.url).searchParams.get("explain") !== "0";
  const [report, activity] = await Promise.all([
    agentReport(id, identity, explain),
    listActivity(identity.id, { agentId: id, limit: 20 }),
  ]);
  return json({ ...report, activity });
});

const patch = z.object({ status: z.enum(["active", "paused"]) });

export const PATCH = withSession<P>(async (req, identity, { id }) => {
  rateLimit("manage", identity.id);
  const input = patch.parse(await req.json());
  const report = await agentReport(id, identity, false);
  if (!report.agent.policy?.active && input.status === "active") {
    return json({ error: "Attach a permission passport before activating this agent." }, { status: 400 });
  }
  const { score, chainSync } = await setAgentStatus(id, input.status);
  return json({ ok: true, score: score.score, chainSync });
});
