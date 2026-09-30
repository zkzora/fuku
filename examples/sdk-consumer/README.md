# @fuku/sdk consumer example

A small external program that uses only `@fuku/sdk`, the same public API and enforcement path every
client gets, and checks the chain itself with viem instead of trusting Fuku's word.

It loads the seeded Payments Agent and verifies it. It then shows the owner's approval: the passport
in Fuku, and the mandate the owner's own wallet opened on-chain. After that it:

1. previews a 25 aUSDC payment,
2. submits it with an idempotency key and retries with the same key (the retry replays and pays nothing),
3. reads the receipt,
4. verifies the `GuardedTransferExecuted` event on-chain (action hash, recipient, amount, complianceRef),
5. revokes access,
6. and shows the next attempt fails.

## Run it

You need a Fuku instance with a live chain. The local Hardhat setup in [`docs/CLEANVERSE.md`](../../docs/CLEANVERSE.md#run-it-locally-verified-2026-09-30) works; run `npm run cleanverse:setup` there first.

```bash
npm run build -w sdk
FUKU_BASE_URL=http://localhost:3002 FUKU_API_KEY=fk_live_demo_ava_chen_2026 \
MONAD_RPC_URL=http://127.0.0.1:8545 node examples/sdk-consumer/index.mjs
```

It exits 0 when every step behaves as expected. It revokes the Payments Agent's passport, so reset the
demo afterwards (`/api/auth/demo?reset=1`).

The demo key belongs to the seeded owner. A third-party application would use its own key plus an
`agents:execute` delegation that the owner grants in the Developer Console. Without one, its calls
for the owner's agents are refused with 403.
