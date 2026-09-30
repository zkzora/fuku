import type { NextRequest } from "next/server";
import { db } from "./db";
import { RequestError } from "./errors";

export const RP_NAME = "Fuku Protocol";

/**
 * Origins allowed to run passkey ceremonies: WEBAUTHN_ORIGINS (comma separated), else
 * NEXT_PUBLIC_APP_URL. Outside production, http://localhost and http://127.0.0.1 on any port are
 * also accepted so local runs on 3001/3002 work without configuration. The origin is never taken
 * on trust from the request: a request from an origin outside the list is refused.
 */
export function allowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.WEBAUTHN_ORIGINS?.trim() || env.NEXT_PUBLIC_APP_URL?.trim() || "";
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function originAllowed(origin: string, env: Record<string, string | undefined> = process.env): boolean {
  if (allowedOrigins(env).includes(origin)) return true;
  return env.NODE_ENV !== "production" && LOCAL_ORIGIN.test(origin);
}

/** Relying-party id and the (allow-listed) origin for this request. */
export function rpFromRequest(req: NextRequest | Request, env: Record<string, string | undefined> = process.env) {
  const origin = (req.headers.get("origin") ?? new URL(req.url).origin).replace(/\/+$/, "");
  if (!originAllowed(origin, env)) {
    throw new RequestError(`Passkeys are not enabled for ${origin}. Add it to WEBAUTHN_ORIGINS.`, 400, "origin_not_allowed");
  }
  const rpID = env.WEBAUTHN_RP_ID?.trim() || new URL(origin).hostname;
  return { rpID, origin };
}

/**
 * Consume a stored challenge exactly once. The delete is conditional on the row still existing and
 * not being expired, so two concurrent verifications of the same challenge cannot both succeed.
 */
export async function consumeChallenge(id: string, kind: "register" | "authenticate" | "wallet") {
  const challenge = await db.challenge.findUnique({ where: { id } });
  if (!challenge || challenge.kind !== kind) throw new RequestError("Challenge expired. Please try again.", 400, "challenge_invalid");
  const consumed = await db.challenge.deleteMany({ where: { id, kind, expiresAt: { gt: new Date() } } });
  if (consumed.count !== 1) throw new RequestError("Challenge expired or already used. Please try again.", 400, "challenge_invalid");
  return challenge;
}

/** Store a new challenge for 5 minutes, and sweep expired ones. */
export async function storeChallenge(challenge: string, kind: "register" | "authenticate" | "wallet", identityId?: string) {
  await db.challenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return db.challenge.create({ data: { challenge, kind, identityId, expiresAt: new Date(Date.now() + 5 * 60_000) } });
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
