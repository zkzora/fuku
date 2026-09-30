import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { requireActFor } from "@/lib/services/authz";
import { bindWallet, walletChallenge } from "@/lib/services/identity";

type P = { id: string };

/**
 * SDK: bind a wallet to an identity by signature. The signature over the one-time challenge is the
 * proof of control, so the caller only needs to manage the identity (itself, a managed identity or
 * an agents:manage delegation); it can never bind a wallet it cannot sign for.
 *   POST { wallet }                 -> { challengeId, message, expiresAt }
 *   PUT  { challengeId, signature } -> walletVerifiedBy "signature"
 */
const start = z.object({ wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const finish = z.object({ challengeId: z.string().min(1), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });

export const POST = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  await requireActFor(caller, id, "agents:manage");
  const identity = await db.identity.findUniqueOrThrow({ where: { id } });
  return json(await walletChallenge(identity, start.parse(await req.json()).wallet));
});

export const PUT = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  await requireActFor(caller, id, "agents:manage");
  const identity = await db.identity.findUniqueOrThrow({ where: { id } });
  const input = finish.parse(await req.json());
  const updated = await bindWallet(identity, { challengeId: input.challengeId, signature: input.signature as `0x${string}` });
  return json({ identity: { id: updated.id, walletAddress: updated.walletAddress, walletVerifiedBy: updated.walletVerifiedBy } });
});
