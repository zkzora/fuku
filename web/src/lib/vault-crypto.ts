/**
 * Client-side encryption for the Memory Vault. Runtime-neutral (browser + Node 24 WebCrypto).
 * The server only ever stores ciphertext; the key is derived on the user's device from a
 * passphrase and never leaves it.
 */
const subtle = () => globalThis.crypto.subtle;

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str: string): Uint8Array {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveVaultKey(identityId: string, passphrase: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await subtle().importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt: enc.encode(`fuku-vault:${identityId}`), iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptText(key: CryptoKey, plaintext: string) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const buf = await subtle().encrypt({ name: "AES-GCM", iv }, key, data);
  return { ciphertext: b64encode(new Uint8Array(buf)), iv: b64encode(iv), sizeBytes: data.byteLength };
}

export async function decryptText(key: CryptoKey, ciphertext: string, iv: string): Promise<string> {
  const buf = await subtle().decrypt(
    { name: "AES-GCM", iv: b64decode(iv) as BufferSource },
    key,
    b64decode(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(buf);
}

/**
 * Public passphrase of the seeded demo identity (Ava) only, so the demo vault opens without setup.
 * Anyone can derive that key: the demo vault is not secret. Every other identity chooses its own.
 */
export const DEMO_VAULT_PASSPHRASE = "fuku-demo-vault";

/** Encrypted under the owner's key as `Identity.vaultCheck`; decrypting it proves the passphrase. */
export const VAULT_CHECK_PLAINTEXT = "fuku-vault-check:v1";
export const MIN_VAULT_PASSPHRASE_LENGTH = 10;

/** True when `key` opens the stored check, i.e. it was derived from the owner's passphrase. */
export async function vaultKeyMatches(key: CryptoKey, check: { ciphertext: string; iv: string }): Promise<boolean> {
  try {
    return (await decryptText(key, check.ciphertext, check.iv)) === VAULT_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}
