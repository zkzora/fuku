import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Cleanverse request encryption: AES-CBC, key = base64-decoded API key (16, 24 or 32 bytes),
 * IV = 16 zero bytes, PKCS7 padding, ciphertext as base64. Used for write endpoints, and to
 * decrypt a `data` field that comes back as a base64 string.
 */
const ZERO_IV = Buffer.alloc(16, 0);

export function cleanverseKey(apiKeyBase64: string): Buffer {
  const key = Buffer.from(apiKeyBase64, "base64");
  if (![16, 24, 32].includes(key.length)) {
    throw new Error(`CLEANVERSE_API_KEY must decode to 16, 24 or 32 bytes (got ${key.length})`);
  }
  return key;
}

const algorithm = (key: Buffer) => `aes-${key.length * 8}-cbc`;

export function encryptPayload(plaintext: string, apiKeyBase64: string): string {
  const key = cleanverseKey(apiKeyBase64);
  const cipher = createCipheriv(algorithm(key), key, ZERO_IV);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

export function decryptPayload(ciphertextBase64: string, apiKeyBase64: string): string {
  const key = cleanverseKey(apiKeyBase64);
  const decipher = createDecipheriv(algorithm(key), key, ZERO_IV);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, "base64")), decipher.final()]).toString("utf8");
}

/** `{ data: base64(AES-CBC(JSON)) }` body for encrypted endpoints. */
export function encryptedEnvelope(body: unknown, apiKeyBase64: string): { data: string } {
  return { data: encryptPayload(JSON.stringify(body), apiKeyBase64) };
}
