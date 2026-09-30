import { z } from "zod";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession, getCurrentIdentity } from "@/lib/session";
import { createIdentity } from "@/lib/services/identity";
import { DynamicAuthError, verifyDynamicToken } from "@/lib/dynamic-auth";

const body = z.object({
  token: z.string().min(20),
  /** Link the Dynamic wallet to the signed-in Fuku identity instead of signing in. */
  link: z.boolean().optional(),
});

/**
 * Exchanges a Dynamic JWT for a Fuku session. The JWT is verified server-side (RS256 against the
 * environment's JWKS, issuer and `user:basic` scope) and only its claims are trusted: the wallet
 * address and email come from the token, never from the request body.
 */
export const POST = withErrors(async (req) => {
  const input = body.parse(await req.json());
  let user;
  try {
    user = await verifyDynamicToken(input.token);
  } catch (e) {
    if (e instanceof DynamicAuthError) return json({ error: e.message }, { status: 401 });
    throw e;
  }
  if (!user.evmAddress) {
    return json({ error: "Your Dynamic wallet is still being created.", code: "wallet_pending" }, { status: 409 });
  }

  const owner = await db.identity.findFirst({
    where: { OR: [{ dynamicUserId: user.userId }, { walletAddress: user.evmAddress }] },
  });

  if (input.link) {
    const current = await getCurrentIdentity();
    if (!current) return json({ error: "Sign in to Fuku first, then link a wallet." }, { status: 401 });
    if (owner && owner.id !== current.id) {
      return json({ error: `This Dynamic account is already linked to ${owner.displayName}.` }, { status: 409 });
    }
    const identity = await db.identity.update({
      where: { id: current.id },
      data: { walletAddress: user.evmAddress, dynamicUserId: user.userId, email: current.email ?? user.email },
    });
    return json({ identity, linked: true });
  }

  let identity = owner;
  let created = false;
  if (!identity) {
    // A Dynamic email sign-in proves control of an inbox, not personhood: the identity starts
    // unverified until its owner completes a passkey (WebAuthn) ceremony.
    ({ identity } = await createIdentity({
      displayName: user.displayName,
      authMethod: "dynamic",
      walletAddress: user.evmAddress,
      humanVerified: false,
    }));
    created = true;
  }
  identity = await db.identity.update({
    where: { id: identity.id },
    data: { dynamicUserId: user.userId, email: identity.email ?? user.email, walletAddress: identity.walletAddress ?? user.evmAddress },
  });
  await createSession(identity.id);
  return json({ identity, created });
});
