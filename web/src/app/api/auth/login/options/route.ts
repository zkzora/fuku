import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { rpFromRequest } from "@/lib/webauthn";

export const POST = withErrors(async (req) => {
  const { rpID } = rpFromRequest(req);
  // Discoverable credentials: the authenticator picks the passkey, so no allowCredentials.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  const challenge = await db.challenge.create({
    data: { challenge: options.challenge, kind: "authenticate", expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return json({ challengeId: challenge.id, options });
});
