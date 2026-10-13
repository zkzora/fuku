import type { Identity } from "@prisma/client";
import { isAddress, sha256, stringToHex, type Hex } from "viem";
import { db } from "../db";
import { newIdentityId, hashJson, randomToken } from "../ids";
import { chainConfig, chainReader } from "../chain";
import { RequestError } from "../errors";
import { consumeChallenge, storeChallenge } from "../webauthn";
import { parseWalletBindingMessage, verifyWalletSignature, walletBindingMessage } from "../wallet-binding";
import { storedAPass } from "./cleanverse";
import { DEMO_API_KEY, demoEnabled } from "../demo-mode";

/**
 * Create a Fuku identity. Nothing is sent on-chain here: anchoring waits for the identity's first
 * write, so an owner who binds a wallet first can register it from that wallet (owner custody; see
 * lib/custody.ts). Identities without a bound wallet are anchored lazily by the relayer.
 */
export async function createIdentity(input: {
  displayName: string;
  authMethod: "passkey" | "wallet" | "demo" | "dynamic";
  passkeyPubKeyHash?: Hex;
  /** Declared unless `walletVerifiedBy` says how control was proven. */
  walletAddress?: string;
  walletVerifiedBy?: "dynamic" | "signature";
  walletProof?: string;
  humanVerified: boolean;
  /** The API caller creating this identity for one of its users (recorded management grant). */
  managedById?: string;
}) {
  const id = newIdentityId();
  const proofHash = hashJson({ id, key: input.passkeyPubKeyHash ?? input.walletAddress ?? null, at: Date.now() });
  const identity = await db.identity.create({
    data: {
      id,
      displayName: input.displayName,
      humanVerified: input.humanVerified,
      authMethod: input.authMethod,
      walletAddress: input.walletAddress?.toLowerCase(),
      walletVerifiedBy: input.walletAddress ? (input.walletVerifiedBy ?? null) : null,
      walletVerifiedAt: input.walletAddress && input.walletVerifiedBy ? new Date() : null,
      walletProof: input.walletAddress && input.walletVerifiedBy ? (input.walletProof ?? null) : null,
      managedById: input.managedById ?? null,
      proofHash,
      proofMode: "deferred",
    },
  });
  // No receipt: the identity is anchored on its first on-chain write (see the doc comment).
  return { identity, receipt: null };
}

export function hashApiKey(raw: string): string {
  return sha256(stringToHex(raw));
}

export async function createApiKey(identityId: string, name: string) {
  const raw = `fk_live_${randomToken(18)}`;
  const key = await db.apiKey.create({
    data: { identityId, name, prefix: raw.slice(0, 12), keyHash: hashApiKey(raw) },
  });
  return { key, raw };
}

export async function identityFromApiKey(raw: string | null): Promise<Identity | null> {
  return (await apiKeyFromRaw(raw))?.identity ?? null;
}

/** The stored key a raw API key matches, with its identity; null for unknown or disabled keys. */
export async function apiKeyFromRaw(raw: string | null) {
  if (!raw || !raw.startsWith("fk_")) return null;
  if (raw === DEMO_API_KEY && !demoEnabled()) return null;
  const key = await db.apiKey.findFirst({ where: { keyHash: hashApiKey(raw) }, include: { identity: true, agent: { select: { identityId: true } } } });
  if (!key) return null;
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key;
}

// --- Wallet binding ----------------------------------------------------------------------------

const BINDING_TTL_MS = 5 * 60_000;

/** Start a wallet binding: returns the exact message the wallet must sign (valid 5 minutes, once). */
export async function walletChallenge(identity: Identity, wallet: string) {
  if (!isAddress(wallet)) throw new RequestError("Not an EVM address", 400, "invalid_wallet");
  const issuedAt = new Date();
  const message = walletBindingMessage({
    identityId: identity.id,
    wallet,
    nonce: randomToken(16),
    chainId: chainConfig().id,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + BINDING_TTL_MS).toISOString(),
  });
  const challenge = await storeChallenge(message, "wallet", identity.id);
  return { challengeId: challenge.id, message, expiresAt: challenge.expiresAt.toISOString() };
}

/**
 * Finish a wallet binding. The challenge is consumed once, must belong to this identity and be
 * unexpired, and the signature must verify for the wallet named in the message. A wallet already
 * bound (verified) to another identity cannot be bound again.
 */
export async function bindWallet(identity: Identity, input: { challengeId: string; signature: Hex }) {
  const challenge = await consumeChallenge(input.challengeId, "wallet");
  if (challenge.identityId !== identity.id) throw new RequestError("This challenge belongs to another identity.", 400, "challenge_invalid");
  const fields = parseWalletBindingMessage(challenge.challenge);
  if (!fields || fields.identityId !== identity.id) throw new RequestError("Malformed binding challenge.", 400, "challenge_invalid");
  if (Date.parse(fields.expiresAt) < Date.now()) throw new RequestError("Binding challenge expired.", 400, "challenge_invalid");
  const ok = await verifyWalletSignature({ wallet: fields.wallet, message: challenge.challenge, signature: input.signature, client: chainReader() });
  if (!ok) throw new RequestError("The signature does not match the wallet.", 400, "bad_signature");
  const wallet = fields.wallet.toLowerCase();
  const taken = await db.identity.findFirst({ where: { walletAddress: wallet, walletVerifiedBy: { not: null }, NOT: { id: identity.id } } });
  if (taken) throw new RequestError("This wallet is already bound to another Fuku identity.", 409, "wallet_taken");
  return db.identity.update({
    where: { id: identity.id },
    data: {
      walletAddress: wallet,
      walletVerifiedBy: "signature",
      walletVerifiedAt: new Date(),
      walletProof: JSON.stringify({ message: challenge.challenge, signature: input.signature }),
    },
  });
}

// --- Verification statuses ---------------------------------------------------------------------

export interface VerificationStatus {
  /** WebAuthn ceremony with user verification. Evidence that the key holder was present. */
  passkey: { status: "verified" | "none"; evidence: string };
  /** Control of the owner wallet: a verified Dynamic credential or a signed binding message. */
  wallet: { status: "verified" | "declared" | "none"; method: "dynamic" | "signature" | null; address: string | null; verifiedAt: string | null };
  /** Fuku does not establish unique personhood; stated explicitly so no caller infers it. */
  uniqueHuman: { status: "not_established"; evidence: string };
  /** Cleanverse A-Pass for the verified wallet, from the last persisted read (no provider call). */
  cleanverse: { status: "eligible" | "frozen" | "expired" | "not_found" | "unchecked" | "unbound" | "off"; mode: string; source: string; checkedAt: string | null };
}

export async function verificationOf(identity: Identity): Promise<VerificationStatus> {
  const passkeys = await db.passkey.count({ where: { identityId: identity.id } });
  const walletMethod = identity.walletVerifiedBy === "dynamic" || identity.walletVerifiedBy === "signature" ? identity.walletVerifiedBy : null;
  const walletStatus = !identity.walletAddress ? "none" : walletMethod ? "verified" : "declared";
  const apass = await storedAPass(walletStatus === "verified" ? identity.walletAddress : null);
  const cleanverse: VerificationStatus["cleanverse"]["status"] =
    apass.mode === "off"
      ? "off"
      : walletStatus !== "verified"
        ? "unbound"
        : !apass.checkedAt
          ? "unchecked"
          : !apass.found || !apass.pass
            ? "not_found"
            : apass.pass.status === 2
              ? "frozen"
              : apass.pass.expired
                ? "expired"
                : apass.pass.status === 1
                  ? "eligible"
                  : "not_found";
  return {
    passkey: {
      status: identity.humanVerified ? "verified" : "none",
      evidence: identity.humanVerified
        ? passkeys > 0
          ? `WebAuthn passkey with user verification (${passkeys} on record)`
          : "Seeded demo record (no live passkey ceremony)"
        : "No passkey ceremony completed",
    },
    wallet: {
      status: walletStatus,
      method: walletMethod,
      address: identity.walletAddress ?? null,
      verifiedAt: identity.walletVerifiedAt?.toISOString() ?? null,
    },
    uniqueHuman: { status: "not_established", evidence: "Fuku does not verify unique personhood or run KYC." },
    cleanverse: { status: cleanverse, mode: apass.mode, source: apass.source, checkedAt: apass.checkedAt },
  };
}
