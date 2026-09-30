# Identity custody migration plan

Status on 2026-09-30. The four registries on Monad testnet are byte-for-byte identical to this branch's build: runtime bytecode and metadata compared with `eth_getCode`. They were not redeployed.

## What decides custody

`HumanIdentityRegistry.registerIdentity` makes `msg.sender` the identity's controller. The registries have no way to transfer control afterwards. Every write that governs an agent checks that controller:

| Function | Who may send it |
| --- | --- |
| `AgentRegistry.registerAgent` | the identity's controller |
| `AgentRegistry.setStatus` | the identity's controller |
| `PermissionRegistry.setPolicy` | the identity's controller |
| `PermissionRegistry.revokePolicy` | the identity's controller |
| `PermissionRegistry.recordDecision` | an enforcer, or the controller |
| `ReputationRegistry.updateScore` | a scorer |
| `HumanIdentityRegistry.setHumanVerified` | the registry owner |

So whoever sends `registerIdentity` first is the controller forever. **Redeploying the registries does not change that.** If the relayer registered identities again after a redeploy, it would be their controller again. What changes custody is the owner's wallet sending the registration itself.

## What is implemented (commit "Owner-controlled identities")

- **Custody rule.** An identity whose wallet is bound (by signature or a verified Dynamic credential) before its first on-chain write is owner-controlled. The rule lives in `web/src/lib/custody.ts`, and the decision is stored in `Identity.chainCustody`.
  - The seeded demo identity (Ava) stays custodial and is labelled "custodial demo".
  - Identities without a wallet, and identities the relayer registered earlier, stay custodial.
- **Nothing on-chain at creation.** Identities are no longer anchored when they are created. Anchoring waits for the first write, so an owner can bind a wallet first.
- **Fuku never signs for owner-controlled identities.**
  - The relayer does not send `registerIdentity`, `registerAgent`, `setPolicy`, `revokePolicy` or `setStatus` for them. Such writes return `awaiting-owner` receipts, and a guarded transfer is rejected with `R10 OWNER_SIGNATURE_REQUIRED`.
  - `GET /api/chain/owner-actions` (and `GET /api/v1/identities/:id/owner-actions`) compares the database with the registries and prepares the exact calldata for each write still missing.
  - The owner's wallet sends it. The Identity page offers "Sign with my wallet", through the injected wallet or Dynamic.
  - `POST …/owner-actions` confirms a sent transaction. It checks the receipt, the sender (the bound wallet), the target registry and the decoded event with its expected arguments. For `registerIdentity` it also re-reads `controllerOf`. Only then does the database record the transaction.
- **What the relayer still does for these identities:**
  - records decisions (as enforcer) and scores (as scorer);
  - attests the passkey flag (as registry owner).
  It can no longer register, re-anchor, revoke or pause for them.

Evidence (local Hardhat node, `web/scripts/live-smoke.mjs`, 65/65 on a fresh node):
- `controllerOf(identity)` equals the owner wallet.
- `isOwnerController(agent, owner) = true` and `isOwnerController(agent, relayer) = false`.
- The relayer's `revokePolicy` simulates to `NotAgentOwner`, and its `setStatus` to `NotIdentityController`.
- A passport update after the owner registered the agent returns `awaiting-owner`. The owner-signed `setPolicy` v2 is confirmed and active. (Before the fix in "Adversarial checks", `docs/SECURITY.md` section 7, the relayer tried it and recorded a failure.)
- The owner-signed `revokePolicy` is confirmed, and `policies(agent).active = false` afterwards.

## Plan for identities that are already custodial

These are the identities the relayer registered before custody existed, and the seeded demo. The registry cannot hand them over, so moving one to its owner means registering new on-chain records from the owner's wallet. There are two options.

**Option A (no redeploy): re-key, recommended**

1. **Identity.** Add `Identity.onchainKey` (default `keccak256(id)`, as today). For a migrating identity, set it to `keccak256(id + "#owner-1")`. The owner binds a wallet and signs `registerIdentity(onchainKey, …)`. Verify `controllerOf(onchainKey) == wallet`.
2. **Agents.** Add `Agent.onchainKey` the same way. The owner signs `registerAgent(newKey, onchainKey, …)` and `setPolicy(newKey, …)` for the current passport version.
   - The relayer, still the controller of the old records, sends `revokePolicy(oldKey)` and `setStatus(oldKey, Revoked)`. The guard then refuses anything attested against the old key.
   - History stays on the old keys. The app shows both, linked by the Fuku id in `metadataURI`.
3. **Mandates.** Mandates are keyed by agent. The owner closes the old mandate and opens a new one for the new agent key (`closeMandate` / `openMandate`), then re-adds payees.
4. **Indexer.** Nothing to redeploy: same contracts, same start block. The HyperSync feed queries both keys for a migrated subject, and the HyperIndex `Identity` entity shows the new controller.
5. **Verification.** For each migrated identity, check `controllerOf`, `isOwnerController` for the owner (true) and the relayer (false), a relayer `revokePolicy` simulation reverting `NotAgentOwner`, and an owner-signed transfer through the guard.

**Option B (redeploy, only if the registries need new features anyway)**

Deploy registries that add `transferController(identityId, newController)`, callable by the current controller together with a signature from the new one. Then migrate each identity with an owner-signed `transferController`.

This costs a whole new stack:
- registries, guard (its constructor takes the registry addresses) and simulators;
- new `deployments/monadTestnet.json`, `wire:env`, the Envio config and start block;
- fresh history (old decisions stay readable on the old contracts only).

It only helps identities whose current controller cooperates. Here that is the relayer, so the result is the same as option A with more moving parts. Not recommended now.

## Not planned

Taking custody away from a controller without its cooperation. The registry, correctly, does not allow it.
