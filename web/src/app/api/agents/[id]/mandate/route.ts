import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { chainConfig, chainMode, readMandate, spendGuardAddress } from "@/lib/chain";
import { idToBytes32 } from "@/lib/ids";
import { cleanverseRuntime } from "@/lib/services/cleanverse";
import { reconcileSoon } from "@/lib/services/reconcile";

type P = { id: string };

/**
 * The owner's FukuSpendGuard mandate for this agent (read from chain), plus what the owner needs to
 * open one from their own wallet: the guard, the A-Token and the chain. In mock-chain mode or
 * without a guard there is nothing to read; `reason` says why.
 */
export const GET = withSession<P>(async (_req, identity, { id }) => {
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  // The owner may just have changed its allowance: let the watcher bump the wallet's validAfter.
  void reconcileSoon({ identityId: identity.id });
  const wallet = identity.walletVerifiedBy ? identity.walletAddress : null;
  const guard = spendGuardAddress();
  const rt = cleanverseRuntime();
  const token = rt.provider ? ((await rt.provider.resolveAsset("aUSDC").catch(() => null))?.address ?? null) : null;
  const target = { guard, token, chainId: chainConfig().id, agentKey: idToBytes32(agent.id), walletVerifiedBy: identity.walletVerifiedBy };
  if (chainMode() !== "live") return json({ mandate: null, wallet, reason: "mock-chain", ...target });
  if (!guard) return json({ mandate: null, wallet, reason: "guard-not-configured", ...target });
  if (!wallet) return json({ mandate: null, wallet: null, reason: "no-wallet", ...target });
  try {
    return json({ mandate: await readMandate(agent.id, wallet), wallet, reason: null, ...target });
  } catch (err) {
    return json({ mandate: null, wallet, reason: "read-failed", error: (err as Error).message, ...target }, { status: 502 });
  }
});
