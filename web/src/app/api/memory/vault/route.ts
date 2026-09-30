import { z } from "zod";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { resetVault, setVaultPassphrase } from "@/lib/services/vault";

/**
 * The owner's vault passphrase (lib/services/vault.ts). The browser derives the key; the server gets
 * ciphertext only.
 *   POST   { check, items } -> set or change it: the new check value and every item re-encrypted
 *   DELETE { confirm: true } -> forgotten passphrase: delete every item and start over
 */
const sealed = z.object({ ciphertext: z.string().min(1).max(200_000), iv: z.string().min(1).max(64) });
const setBody = z.object({ check: sealed, items: z.array(sealed.extend({ id: z.string().min(1) })).max(1000) });
const resetBody = z.object({ confirm: z.literal(true) });

export const POST = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  return json({ vault: await setVaultPassphrase(identity, setBody.parse(await req.json())) });
});

export const DELETE = withSession(async (req, identity) => {
  rateLimit("manage", identity.id);
  resetBody.parse(await req.json());
  return json(await resetVault(identity));
});
