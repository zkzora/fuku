import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { RequestError } from "@/lib/errors";
import { chainMode } from "@/lib/chain";
import { authorizedAgent } from "@/lib/services/authz";
import { verifyScoreFromChain } from "@/lib/services/verify-score";

type P = { id: string };

/**
 * SDK: fuku.verifyScore() — "Recompute from chain" over the API: every decision record Fuku reveals
 * is checked against the proof anchored for its action, fuku-score/2 is recomputed from what checks
 * out, and compared with the score anchored in ReputationRegistry and with Fuku's ledger. `verified`
 * is the ✓. For callers who may act for the agent (the owner, or a delegate with agents:execute).
 */
export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { agent } = await authorizedAgent(caller, id, "agents:execute");
  if (chainMode() !== "live") throw new RequestError("The chain is mocked: there is nothing on-chain to recompute from.", 409, "mock_chain");
  return json(await verifyScoreFromChain(agent.id));
}, { agentKey: { scope: "agent:read", agentParam: "id" } });
