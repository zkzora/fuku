import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { bindWallet, walletChallenge } from "@/lib/services/identity";

/**
 * Wallet binding for the signed-in identity.
 *   POST { wallet }                  -> { challengeId, message, expiresAt }: sign `message` with the wallet
 *   PUT  { challengeId, signature }  -> the identity with walletVerifiedBy "signature"
 */
const start = z.object({ wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const finish = z.object({ challengeId: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });

export const POST = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  const { wallet } = start.parse(await req.json());
  return json(await walletChallenge(identity, wallet));
});

export const PUT = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  const input = finish.parse(await req.json());
  const updated = await bindWallet(identity, { challengeId: input.challengeId, signature: input.signature as `0x${string}` });
  return json({ identity: { id: updated.id, walletAddress: updated.walletAddress, walletVerifiedBy: updated.walletVerifiedBy, walletVerifiedAt: updated.walletVerifiedAt } });
});
