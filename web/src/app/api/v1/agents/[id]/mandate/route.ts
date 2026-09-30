import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { chainConfig, chainMode, readMandate, spendGuardAddress } from "@/lib/chain";
import { idToBytes32 } from "@/lib/ids";
import { cleanverseRuntime } from "@/lib/services/cleanverse";
import { authorizedAgent } from "@/lib/services/authz";

type P = { id: string };

/**
 * SDK: fuku.getMandate() — the owner's on-chain FukuSpendGuard mandate for this agent (token, daily
 * cap, per-transfer limit, expiry, payee restriction, version, spent today). The mandate is the
 * owner's own delegation to the agent: opened from the owner's wallet, enforced by the guard.
 */
export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { agent } = await authorizedAgent(caller, id, "agents:execute");
  const owner = await db.identity.findUniqueOrThrow({ where: { id: agent.identityId } });
  const wallet = owner.walletVerifiedBy ? owner.walletAddress : null;
  // What the owner's wallet needs to open a mandate itself: the guard, the A-Token and the agent's key.
  const guard = spendGuardAddress();
  const rt = cleanverseRuntime();
  const token = rt.provider ? ((await rt.provider.resolveAsset("aUSDC").catch(() => null))?.address ?? null) : null;
  const target = { guard, token, chainId: chainConfig().id, agentKey: idToBytes32(agent.id) };
  if (chainMode() !== "live") return json({ mandate: null, wallet, reason: "mock-chain", ...target });
  if (!guard) return json({ mandate: null, wallet, reason: "guard-not-configured", ...target });
  if (!wallet) return json({ mandate: null, wallet: null, reason: "no-verified-wallet", ...target });
  return json({ mandate: await readMandate(agent.id, wallet), wallet, reason: null, ...target });
});
