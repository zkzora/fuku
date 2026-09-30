import type { Identity } from "@prisma/client";
import { sha256, stringToHex, type Hex } from "viem";
import { db } from "../db";
import { newIdentityId, hashJson, randomToken } from "../ids";
import { anchorIdentity } from "../chain";

export async function createIdentity(input: {
  displayName: string;
  authMethod: "passkey" | "wallet" | "demo" | "dynamic";
  passkeyPubKeyHash?: Hex;
  walletAddress?: string;
  humanVerified: boolean;
}) {
  const id = newIdentityId();
  const proofHash = hashJson({ id, key: input.passkeyPubKeyHash ?? input.walletAddress ?? null, at: Date.now() });
  const receipt = await anchorIdentity(id, input.passkeyPubKeyHash ?? proofHash, proofHash, input.humanVerified);
  const identity = await db.identity.create({
    data: {
      id,
      displayName: input.displayName,
      humanVerified: input.humanVerified,
      authMethod: input.authMethod,
      walletAddress: input.walletAddress,
      proofHash,
      proofTxHash: receipt.txHash,
      proofBlock: receipt.block,
    },
  });
  return { identity, receipt };
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
  if (!raw || !raw.startsWith("fk_")) return null;
  const key = await db.apiKey.findFirst({ where: { keyHash: hashApiKey(raw) }, include: { identity: true } });
  if (!key) return null;
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key.identity;
}
