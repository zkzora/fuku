import { generateRegistrationOptions } from "@simplewebauthn/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { RP_NAME, rpFromRequest } from "@/lib/webauthn";

const body = z.object({ displayName: z.string().trim().min(1).max(60) });

export const POST = withErrors(async (req) => {
  const { displayName } = body.parse(await req.json());
  const { rpID } = rpFromRequest(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challenge = await db.challenge.create({
    data: { challenge: options.challenge, kind: "register", expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return json({ challengeId: challenge.id, options });
});
