import { z } from "zod";
import { json, withApiKey } from "@/lib/api";
import { createIdentity } from "@/lib/services/identity";
import { rateLimit } from "@/lib/rate-limit";

/**
 * SDK: fuku.createIdentity()
 * Creates an identity for an application user. It starts unverified: the wallet is only a
 * declaration until it is bound with a signature, and passkey verification needs a ceremony in the
 * Fuku app. The calling identity is recorded as its manager (`managedById`), which lets that caller
 * register and run agents for it; nobody else can without a delegation.
 */
const body = z.object({
  displayName: z.string().trim().min(1).max(60),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

export const POST = withApiKey(async (req, caller) => {
  rateLimit("create", caller.id);
  const input = body.parse(await req.json());
  const { identity, receipt } = await createIdentity({
    displayName: input.displayName,
    authMethod: "wallet",
    walletAddress: input.walletAddress,
    humanVerified: false,
    managedById: caller.id,
  });
  return json({ identity, receipt }, { status: 201 });
});
