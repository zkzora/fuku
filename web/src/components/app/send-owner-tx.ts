"use client";

import { api } from "@/lib/client";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type PreparedTx = { chainId: number; from: string; to: `0x${string}`; data: `0x${string}` };

const DYNAMIC_ENABLED = Boolean(process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID);

/**
 * Send a transaction Fuku prepared from the owner's own wallet: the Dynamic wallet when that is how
 * the wallet was bound, otherwise the injected wallet, which must be the bound address. The owner's
 * wallet signs and pays; Fuku never does.
 */
export async function sendOwnerTx(walletVerifiedBy: string | null, tx: PreparedTx): Promise<string> {
  if (walletVerifiedBy === "dynamic" && DYNAMIC_ENABLED) {
    const { sendViaDynamic } = await import("@/components/dynamic/dynamic-send");
    return sendViaDynamic(tx.from, tx);
  }
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Use the wallet bound to this identity.");
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (account.toLowerCase() !== tx.from.toLowerCase()) throw new Error(`Switch the wallet to ${tx.from}.`);
  return (await eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: tx.to, data: tx.data, value: "0x0" }] })) as string;
}

/** POST a confirmation, retrying while the transaction is still being mined (about 90 s). */
export async function confirmWhenMined<T>(url: string, payload: unknown): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await api<T>(url, { method: "POST", json: payload });
    } catch (err) {
      if (i >= 44 || !/not found|could not be found|receipt/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
