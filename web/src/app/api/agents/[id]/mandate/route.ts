import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { chainMode, readMandate, spendGuardAddress } from "@/lib/chain";

type P = { id: string };

/**
 * The owner's FukuSpendGuard mandate for this agent (read from chain). In mock-chain mode or
 * without a guard there is nothing to read; `reason` says why.
 */
export const GET = withSession<P>(async (_req, identity, { id }) => {
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const wallet = identity.walletAddress;
  if (chainMode() !== "live") return json({ mandate: null, wallet, reason: "mock-chain" });
  if (!spendGuardAddress()) return json({ mandate: null, wallet, reason: "guard-not-configured" });
  if (!wallet) return json({ mandate: null, wallet, reason: "no-wallet" });
  try {
    return json({ mandate: await readMandate(agent.id, wallet), wallet, reason: null });
  } catch (err) {
    return json({ mandate: null, wallet, reason: "read-failed", error: (err as Error).message }, { status: 502 });
  }
});
