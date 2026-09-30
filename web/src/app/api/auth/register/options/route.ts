import { generateRegistrationOptions } from "@simplewebauthn/server";
import { z } from "zod";
import { json, withErrors } from "@/lib/api";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { RP_NAME, rpFromRequest, storeChallenge } from "@/lib/webauthn";

const body = z.object({ displayName: z.string().trim().min(1).max(60) });

export const POST = withErrors(async (req) => {
  rateLimit("auth", clientIp(req));
  const { displayName } = body.parse(await req.json());
  const { rpID } = rpFromRequest(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    // User verification (PIN, biometric) is required: the passkey proves the owner was present,
    // not merely that a device holds a key. It does not prove a unique human.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const challenge = await storeChallenge(options.challenge, "register");
  return json({ challengeId: challenge.id, options });
});
