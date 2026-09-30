import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "./db";

const COOKIE = "fuku_session";
const DEV_SECRET = "fuku-dev-secret";

/**
 * HS256 key for session JWTs. Development falls back to a fixed secret; production refuses to
 * sign or verify sessions unless FUKU_SESSION_SECRET is a random string of at least 32 characters,
 * because anyone who knows the fallback could forge a session for any identity id.
 */
export function sessionSecret(env: Record<string, string | undefined> = process.env): Uint8Array {
  const raw = env.FUKU_SESSION_SECRET?.trim();
  if (env.NODE_ENV === "production" && (!raw || raw.length < 32 || raw === DEV_SECRET || raw.startsWith("change-me"))) {
    throw new Error("FUKU_SESSION_SECRET must be set to a random string of at least 32 characters in production");
  }
  return new TextEncoder().encode(raw || DEV_SECRET);
}

export async function createSession(identityId: string) {
  const token = await new SignJWT({ sub: identityId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(sessionSecret());
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession() {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function getSessionIdentityId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const key = sessionSecret();
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function getCurrentIdentity() {
  const id = await getSessionIdentityId();
  if (!id) return null;
  return db.identity.findUnique({ where: { id } });
}

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireIdentity() {
  const identity = await getCurrentIdentity();
  if (!identity) throw new UnauthorizedError();
  return identity;
}
