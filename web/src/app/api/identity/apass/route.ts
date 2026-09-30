import { json, withSession } from "@/lib/api";
import { refreshAPass, storedAPass } from "@/lib/services/cleanverse";

/** The owner's last persisted A-Pass read. */
export const GET = withSession(async (_req, identity) => json(await storedAPass(identity.walletAddress)));

/** Re-read the owner's A-Pass from the provider (Cleanverse or the simulator) and persist it. */
export const POST = withSession(async (_req, identity) => {
  if (!identity.walletAddress) return json({ error: "Link a wallet first: the A-Pass is bound to a wallet." }, { status: 400 });
  try {
    return json(await refreshAPass(identity.walletAddress));
  } catch (err) {
    return json({ error: `A-Pass lookup failed: ${(err as Error).message}` }, { status: 502 });
  }
});
