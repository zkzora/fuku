import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { json, withErrors } from "@/lib/api";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { rpFromRequest, storeChallenge } from "@/lib/webauthn";

export const POST = withErrors(async (req) => {
  rateLimit("auth", clientIp(req));
  const { rpID } = rpFromRequest(req);
  // Discoverable credentials: the authenticator picks the passkey, so no allowCredentials.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const challenge = await storeChallenge(options.challenge, "authenticate");
  return json({ challengeId: challenge.id, options });
});
