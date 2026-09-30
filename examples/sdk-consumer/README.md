# @fuku/sdk consumer example

A small external program that uses only `@fuku/sdk`, the same public API and enforcement path every
client gets. It keeps its agent's key to itself and checks the chain with viem instead of trusting Fuku.

It creates its own agent under the owner and generates that agent's key locally; the key never leaves
the process. The seeded demo agents keep keys that Fuku holds for them (the app labels them so). Then:

1. **Owner approval.** The owner approves a passport in Fuku. The owner's own wallet opens the on-chain mandate and approves the supplier as a payee. Fuku only names the guard, the token and the agent key.
2. **ERC-8004.**
   - The owner's wallet registers the agent on the canonical Identity Registry.
   - The locally generated agent key signs `AgentWalletSet`. Fuku checks the signature and prepares `setAgentWallet`, which the owner's wallet sends.
   - The program reads `ownerOf` and `getAgentWallet` itself.
3. **Payment.**
   - It previews a 25 aUSDC payment.
   - It submits the payment with an idempotency key, then retries with the same key. The retry replays and pays nothing.
   - It verifies the `GuardedTransferExecuted` event on-chain: action hash, recipient, amount and complianceRef.
4. **Revocation.** It revokes access and shows that the next attempt fails.

## Run it

You need a Fuku instance with a live chain.
- The local Hardhat setup in [`docs/CLEANVERSE.md`](../../docs/CLEANVERSE.md#run-it-locally-verified-2026-09-30) works for everything except ERC-8004, which that chain does not have. That step is skipped there.
- ERC-8004 runs on Monad testnet, or on a local fork of it.

```bash
npm run build -w sdk
FUKU_BASE_URL=http://localhost:3002 FUKU_API_KEY=fk_live_demo_ava_chen_2026 \
OWNER_PRIVATE_KEY=<the owner's wallet key> \
MONAD_RPC_URL=http://127.0.0.1:8545 node examples/sdk-consumer/index.mjs
```

- `OWNER_PRIVATE_KEY` is the wallet bound to the owner. For the demo owner that is `DEMO_OWNER_PRIVATE_KEY`, which is Hardhat account #2 locally.
- The owner's wallet pays for the owner's transactions: the mandate, the payee, and the two ERC-8004 transactions.
- The program exits 0 when every step behaves as expected.

The demo key belongs to the seeded owner. A third-party application would use its own key plus an
`agents:execute` delegation that the owner grants in the Developer Console. Without one, its calls
for the owner's agents are refused with 403.
