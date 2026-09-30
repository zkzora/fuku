import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Server-side verification of Dynamic-issued JWTs (https://www.dynamic.xyz/docs/auth/tokens).
 * RS256, per-environment key served from the JWKS endpoint; the scope must include `user:basic`
 * (anything else means the user is still mid-flow, e.g. MFA).
 */
export function dynamicEnvironmentId(): string | null {
  return process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID?.trim() || null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksEnv: string | null = null;

function keySet(envId: string) {
  if (!jwks || jwksEnv !== envId) {
    jwks = createRemoteJWKSet(new URL(`https://app.dynamicauth.com/api/v0/sdk/${envId}/.well-known/jwks`));
    jwksEnv = envId;
  }
  return jwks;
}

interface VerifiedCredential {
  address?: string;
  chain?: string;
  format?: string;
  email?: string;
  wallet_name?: string;
  wallet_provider?: string;
}

export interface DynamicUser {
  userId: string;
  email: string | null;
  displayName: string;
  /** First EVM wallet on the user's verified credentials (embedded or external), lowercased. */
  evmAddress: string | null;
  walletName: string | null;
}

export class DynamicAuthError extends Error {}

const dynHealth = globalThis as unknown as { __fukuDynamicHealth?: { ok: boolean; at: string; error?: string } };

/** Outcome of the last Dynamic JWT verification in this process, or null before the first one. */
export function lastDynamicVerification() {
  return dynHealth.__fukuDynamicHealth ?? null;
}

export async function verifyDynamicToken(token: string): Promise<DynamicUser> {
  try {
    const user = await verifyDynamicTokenInner(token);
    dynHealth.__fukuDynamicHealth = { ok: true, at: new Date().toISOString() };
    return user;
  } catch (err) {
    dynHealth.__fukuDynamicHealth = { ok: false, at: new Date().toISOString(), error: (err as Error).message.slice(0, 160) };
    throw err;
  }
}

async function verifyDynamicTokenInner(token: string): Promise<DynamicUser> {
  const envId = dynamicEnvironmentId();
  if (!envId) throw new DynamicAuthError("Dynamic is not configured (NEXT_PUBLIC_DYNAMIC_ENV_ID).");
  let payload: JWTPayload & {
    email?: string;
    given_name?: string;
    alias?: string;
    scope?: string;
    environment_id?: string;
    verified_credentials?: VerifiedCredential[];
  };
  try {
    ({ payload } = await jwtVerify(token, keySet(envId), {
      issuer: `app.dynamicauth.com/${envId}`,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw new DynamicAuthError(`Invalid Dynamic token: ${(err as Error).message}`);
  }
  const scopes = String(payload.scope ?? "").split(/\s+/);
  if (!scopes.includes("user:basic")) {
    throw new DynamicAuthError("Dynamic sign-in is not complete yet (missing user:basic scope).");
  }
  if (!payload.sub) throw new DynamicAuthError("Dynamic token has no subject.");

  const creds = payload.verified_credentials ?? [];
  const evm = creds.find((c) => c.address && (c.chain === "eip155" || c.chain === "evm" || /^0x[0-9a-fA-F]{40}$/.test(c.address)));
  const email = payload.email ?? creds.find((c) => c.format === "email" && c.email)?.email ?? null;
  const displayName = payload.given_name || payload.alias || (email ? email.split("@")[0] : "Dynamic user");

  return {
    userId: payload.sub,
    email,
    displayName,
    evmAddress: evm?.address ? evm.address.toLowerCase() : null,
    walletName: evm?.wallet_name ?? evm?.wallet_provider ?? null,
  };
}
