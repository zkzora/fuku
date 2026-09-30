import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { RequestError } from "@/lib/errors";
import { chainMode } from "@/lib/chain";
import { verifyScoreFromChain } from "@/lib/services/verify-score";

type P = { id: string };

/** "Recompute from chain": the agent's score recomputed from on-chain evidence, input by input. */
export const GET = withSession<P>(async (_req, identity, { id }) => {
  rateLimit("read", identity.id);
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id }, select: { id: true } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  if (chainMode() !== "live") throw new RequestError("The chain is mocked: there is nothing on-chain to recompute from.", 409, "mock_chain");
  return json(await verifyScoreFromChain(agent.id));
});
