import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { keccak256, toHex } from "viem";
import { z } from "zod";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { consumeChallenge, rpFromRequest } from "@/lib/webauthn";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { createIdentity } from "@/lib/services/identity";

const body = z.object({
  challengeId: z.string(),
  displayName: z.string().trim().min(1).max(60),
  deviceLabel: z.string().max(80).optional(),
  response: z.custom<RegistrationResponseJSON>((v) => typeof v === "object" && v !== null),
});

export const POST = withErrors(async (req) => {
  rateLimit("auth", clientIp(req));
  const input = body.parse(await req.json());
  const { rpID, origin } = rpFromRequest(req);
  const challenge = await consumeChallenge(input.challengeId, "register");

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo?.userVerified) {
    return json({ error: "Passkey could not be verified." }, { status: 400 });
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const passkeyPubKeyHash = keccak256(toHex(credential.publicKey));

  // "humanVerified" means: a passkey ceremony with user verification (PIN or biometric) succeeded.
  // It is evidence that the key holder was present, not proof of a unique or KYC-verified human.
  const { identity, receipt } = await createIdentity({
    displayName: input.displayName,
    authMethod: "passkey",
    passkeyPubKeyHash,
    humanVerified: true,
  });
  await db.passkey.create({
    data: {
      id: credential.id,
      identityId: identity.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: JSON.stringify(credential.transports ?? []),
      label: input.deviceLabel ?? "Passkey",
    },
  });
  await createSession(identity.id);
  return json({ identity, receipt });
});
