import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { consumeChallenge, rpFromRequest } from "@/lib/webauthn";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const body = z.object({
  challengeId: z.string(),
  response: z.custom<AuthenticationResponseJSON>((v) => typeof v === "object" && v !== null),
});

export const POST = withErrors(async (req) => {
  rateLimit("auth", clientIp(req));
  const input = body.parse(await req.json());
  const { rpID, origin } = rpFromRequest(req);
  const challenge = await consumeChallenge(input.challengeId, "authenticate");

  const passkey = await db.passkey.findUnique({ where: { id: input.response.id }, include: { identity: true } });
  if (!passkey) return json({ error: "This passkey is not registered with Fuku." }, { status: 404 });

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.id,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
    },
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return json({ error: "Passkey signature invalid or user verification missing." }, { status: 401 });
  }

  await db.passkey.update({ where: { id: passkey.id }, data: { counter: verification.authenticationInfo.newCounter } });
  await createSession(passkey.identityId);
  return json({ identity: passkey.identity });
});
