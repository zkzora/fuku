import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "./db";

const COOKIE = "fuku_session";
const secret = () =>
  new TextEncoder().encode(process.env.FUKU_SESSION_SECRET ?? "fuku-dev-secret");

export async function createSession(identityId: string) {
  const token = await new SignJWT({ sub: identityId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
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
  try {
    const { payload } = await jwtVerify(token, secret());
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
  constructor() {
    super("Unauthorized");
  }
}

export async function requireIdentity() {
  const identity = await getCurrentIdentity();
  if (!identity) throw new UnauthorizedError();
  return identity;
}
