import type { Identity } from "@prisma/client";
import { db } from "../db";
import { DEMO_IDENTITY_ID } from "../demo-mode";
import { RequestError } from "../errors";

/**
 * Memory Vault passphrases. Items are encrypted in the browser under a key derived from the owner's
 * passphrase (lib/vault-crypto.ts); the server stores ciphertext and one encrypted check value, never
 * the passphrase or the key, so it cannot tell whether a passphrase is right and cannot recover it.
 * The seeded demo identity alone keeps the public demo passphrase.
 */
export type VaultMode = "demo" | "passphrase";

export interface VaultState {
  mode: VaultMode;
  hasPassphrase: boolean;
  check: { ciphertext: string; iv: string } | null;
}

type Sealed = { ciphertext: string; iv: string };

export function vaultStateOf(identity: Pick<Identity, "id" | "vaultCheck">): VaultState {
  if (identity.id === DEMO_IDENTITY_ID) return { mode: "demo", hasPassphrase: false, check: null };
  let check: Sealed | null = null;
  try {
    const parsed = identity.vaultCheck ? (JSON.parse(identity.vaultCheck) as Sealed) : null;
    check = parsed?.ciphertext && parsed.iv ? { ciphertext: parsed.ciphertext, iv: parsed.iv } : null;
  } catch {
    check = null;
  }
  return { mode: "passphrase", hasPassphrase: check !== null, check };
}

/** Items can be written only once the owner has a passphrase (or on the demo vault). */
export function assertVaultWritable(identity: Pick<Identity, "id" | "vaultCheck">) {
  const state = vaultStateOf(identity);
  if (state.mode === "passphrase" && !state.hasPassphrase) throw new RequestError("Set your vault passphrase first.", 409, "vault_locked");
}

/**
 * Set or change the passphrase: the new check value plus every item re-encrypted under the new key,
 * written together. A list that does not cover exactly the stored items is refused (409), so no item
 * is left under a key the owner no longer has.
 */
export async function setVaultPassphrase(identity: Identity, input: { check: Sealed; items: (Sealed & { id: string })[] }) {
  if (identity.id === DEMO_IDENTITY_ID) throw new RequestError("The demo vault keeps its public demo passphrase.", 409, "demo_vault");
  const stored = await db.memoryItem.findMany({ where: { identityId: identity.id }, select: { id: true } });
  const given = new Set(input.items.map((i) => i.id));
  if (given.size !== input.items.length || given.size !== stored.length || stored.some((s) => !given.has(s.id))) {
    throw new RequestError("Re-encrypt every vault item under the new key in the same request (the vault changed; reload and retry).", 409, "vault_items_mismatch");
  }
  await db.$transaction([
    ...input.items.map((i) => db.memoryItem.updateMany({ where: { id: i.id, identityId: identity.id }, data: { ciphertext: i.ciphertext, iv: i.iv } })),
    db.identity.update({ where: { id: identity.id }, data: { vaultCheck: JSON.stringify({ v: 1, ciphertext: input.check.ciphertext, iv: input.check.iv }) } }),
  ]);
  return vaultStateOf({ id: identity.id, vaultCheck: JSON.stringify(input.check) });
}

/** A forgotten passphrase cannot be recovered: delete every item and start over. */
export async function resetVault(identity: Identity) {
  if (identity.id === DEMO_IDENTITY_ID) throw new RequestError("Reset the demo instead.", 409, "demo_vault");
  const [deleted] = await db.$transaction([
    db.memoryItem.deleteMany({ where: { identityId: identity.id } }),
    db.identity.update({ where: { id: identity.id }, data: { vaultCheck: null } }),
  ]);
  return { deleted: deleted.count };
}
