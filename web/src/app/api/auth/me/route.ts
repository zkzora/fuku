import { json, withErrors } from "@/lib/api";
import { getCurrentIdentity } from "@/lib/session";

export const GET = withErrors(async () => {
  const identity = await getCurrentIdentity();
  // The wallet binding proof stays server-side.
  return json({ identity: identity ? { ...identity, walletProof: undefined } : null });
});
