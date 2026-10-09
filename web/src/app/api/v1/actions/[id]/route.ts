import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getActionReceipt } from "@/lib/services/actions";
import { reconcile } from "@/lib/services/reconcile";

type P = { id: string };

/**
 * SDK: fuku.getAction() — one action's lifecycle status and evidence (decision, proof hash,
 * complianceRef, actionHash, receipt mode, chain id, tx hashes, block and log locator). Pending
 * transfers are reconciled against the chain before answering.
 */
export const GET = withApiKey<P>(async (_req, caller, { id }, principal) => {
  rateLimit("read", caller.id);
  // An agent key reads only its own agent's actions.
  const onlyAgent = principal.kind === "agent" ? principal.agentId : undefined;
  const first = await getActionReceipt(caller, id, onlyAgent);
  if (first.status === "PENDING" || first.status === "SUBMITTED") {
    await reconcile({ actionId: id, limit: 1 }).catch(() => undefined);
    return json(await getActionReceipt(caller, id, onlyAgent));
  }
  return json(first);
}, { agentKey: { scope: "agent:actions" } });
