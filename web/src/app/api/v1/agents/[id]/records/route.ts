import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authorizedAgent } from "@/lib/services/authz";
import { revealRecords } from "@/lib/services/verify-score";

type P = { id: string };

/**
 * Commit-reveal: every decision record Fuku keeps for the agent (lib/records.ts), across demo resets.
 * A verifier checks keccak256(record) against the proofHash anchored at actionHash on-chain, then
 * recomputes the score from what checks out (scripts/verify-score.ts does exactly that).
 */
export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { agent } = await authorizedAgent(caller, id, "agents:manage");
  return json({ agentId: agent.id, records: await revealRecords(agent.id) });
});
