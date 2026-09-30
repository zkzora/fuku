"use client";

import { getWalletAccounts } from "@dynamic-labs-sdk/client";
import { isEvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import type { Address, Hex } from "viem";
import { dynamicClient } from "./dynamic-client";

/**
 * Send a prepared transaction from the owner's Dynamic wallet. Imported lazily from click handlers
 * (the Dynamic client needs `window`). Fuku prepared `data`; the owner's wallet signs and pays gas.
 */
export async function sendViaDynamic(owner: string, tx: { chainId: number; to: Address; data: Hex }): Promise<Hex> {
  const account = getWalletAccounts(dynamicClient).find((w) => isEvmWalletAccount(w) && w.address.toLowerCase() === owner.toLowerCase());
  if (!account || !isEvmWalletAccount(account)) throw new Error("Sign in with the Dynamic wallet that is bound to this identity.");
  const wc = await createWalletClientForWalletAccount({ walletAccount: account });
  if (wc.chain.id !== tx.chainId) throw new Error(`Switch the Dynamic wallet to chain ${tx.chainId} (it is on ${wc.chain.id}).`);
  return wc.sendTransaction({ to: tx.to, data: tx.data, account: wc.account, chain: wc.chain });
}
