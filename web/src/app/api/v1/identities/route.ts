import { z } from "zod";
import { json, withApiKey } from "@/lib/api";
import { createIdentity } from "@/lib/services/identity";

/**
 * SDK: fuku.createIdentity()
 * Creates an identity for an application user. Human verification happens when that user
 * completes a passkey ceremony in the Fuku app; wallet-only identities start unverified.
 */
const body = z.object({
  displayName: z.string().trim().min(1).max(60),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

export const POST = withApiKey(async (req) => {
  const input = body.parse(await req.json());
  const { identity, receipt } = await createIdentity({
    displayName: input.displayName,
    authMethod: "wallet",
    walletAddress: input.walletAddress,
    humanVerified: false,
  });
  return json({ identity, receipt }, { status: 201 });
});
