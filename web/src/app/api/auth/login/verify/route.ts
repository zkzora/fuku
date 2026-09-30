import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { rpFromRequest } from "@/lib/webauthn";

const body = z.object({
  challengeId: z.string(),
  response: z.custom<AuthenticationResponseJSON>((v) => typeof v === "object" && v !== null),
});

export const POST = withErrors(async (req) => {
  const input = body.parse(await req.json());
  const challenge = await db.challenge.findUnique({ where: { id: input.challengeId } });
  if (!challenge || challenge.kind !== "authenticate" || challenge.expiresAt < new Date()) {
    return json({ error: "Challenge expired. Please try again." }, { status: 400 });
  }
  await db.challenge.delete({ where: { id: challenge.id } });

  const passkey = await db.passkey.findUnique({ where: { id: input.response.id }, include: { identity: true } });
  if (!passkey) return json({ error: "This passkey is not registered with Fuku." }, { status: 404 });

  const { rpID, origin } = rpFromRequest(req);
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: passkey.id,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
    },
  });
  if (!verification.verified) return json({ error: "Passkey signature invalid." }, { status: 401 });

  await db.passkey.update({ where: { id: passkey.id }, data: { counter: verification.authenticationInfo.newCounter } });
  await createSession(passkey.identityId);
  return json({ identity: passkey.identity });
});
