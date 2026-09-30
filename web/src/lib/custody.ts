import { DEMO_IDENTITY_ID } from "./demo-mode";

/**
 * On-chain custody of an identity.
 *
 * owner:   the identity's bound wallet is its controller in HumanIdentityRegistry. That wallet sends
 *          registerIdentity, registerAgent, setPolicy, revokePolicy and setStatus itself; Fuku only
 *          prepares the calldata and confirms by reading the receipt and the decoded event. Fuku's
 *          relayer can still record decisions (enforcer) and scores (scorer), and attest the passkey
 *          flag (registry owner), but it cannot register, re-anchor, revoke or pause for it.
 * relayer: Fuku's relayer key is the controller (custodial). Used for the seeded demo, for identities
 *          without a bound wallet, and for identities the relayer anchored before custody existed.
 *
 * The registries have no controller transfer, so custody is fixed by whoever registers the identity
 * first; once recorded (Identity.chainCustody) it never changes.
 */
export type Custody = "relayer" | "owner";

export function custodyFor(identity: { id: string; walletVerifiedBy?: string | null; walletAddress?: string | null; chainCustody?: string | null }): Custody {
  if (identity.chainCustody === "owner" || identity.chainCustody === "relayer") return identity.chainCustody;
  if (identity.id === DEMO_IDENTITY_ID) return "relayer";
  return identity.walletVerifiedBy && identity.walletAddress ? "owner" : "relayer";
}
