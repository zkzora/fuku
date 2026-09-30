"use client";

import { useState } from "react";
import { getWalletAccounts } from "@dynamic-labs-sdk/client";
import { isEvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { isAddress, parseUnits, publicActions, type Address, type Hex } from "viem";
import { toast } from "sonner";
import { CleanverseATokenSimAbi, FukuSpendGuardAbi } from "@/lib/chain/abi";
import { dynamicClient } from "./dynamic-client";

/**
 * The owner opens (or replaces) the agent's FukuSpendGuard mandate from their own Dynamic wallet:
 * approve the guard on the A-Token, openMandate with a daily cap, per-transfer limit, expiry and a
 * payee restriction, and optionally approve one payee. Nothing here is signed by a Fuku key: the
 * owner's wallet is msg.sender for every call. Loaded with next/dynamic (ssr: false).
 */
export default function DynamicMandate({
  owner,
  guard,
  token,
  chainId,
  agentKey,
  onDone,
}: {
  owner: string;
  guard: Address;
  token: Address;
  chainId: number;
  agentKey: Hex;
  onDone: () => void;
}) {
  const [cap, setCap] = useState("1000");
  const [perTx, setPerTx] = useState("500");
  const [days, setDays] = useState("30");
  const [payee, setPayee] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function open() {
    try {
      if (payee && !isAddress(payee)) throw new Error("The payee is not a valid address.");
      const account = getWalletAccounts(dynamicClient).find((w) => isEvmWalletAccount(w) && w.address.toLowerCase() === owner.toLowerCase());
      if (!account || !isEvmWalletAccount(account)) throw new Error("Sign in with the Dynamic wallet that is bound to this identity.");
      const wc = (await createWalletClientForWalletAccount({ walletAccount: account })).extend(publicActions);
      if (wc.chain.id !== chainId) throw new Error(`Switch the Dynamic wallet to chain ${chainId} (it is on ${wc.chain.id}).`);
      const dailyCap = parseUnits(cap, 6);
      const maxPerTx = parseUnits(perTx, 6);
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + Number(days) * 86_400);
      const send = async (label: string, run: () => Promise<Hex>) => {
        setBusy(label);
        const hash = await run();
        const r = await wc.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
      };
      await send("Approving the guard", () =>
        wc.writeContract({ address: token, abi: CleanverseATokenSimAbi, functionName: "approve", args: [guard, dailyCap * BigInt(Math.max(1, Number(days)))] }),
      );
      await send("Opening the mandate", () =>
        wc.writeContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "openMandate", args: [agentKey, token, dailyCap, maxPerTx, validUntil, Boolean(payee)] }),
      );
      if (payee) {
        await send("Approving the payee", () => wc.writeContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "setPayee", args: [agentKey, payee as Address, true] }));
      }
      toast.success("Mandate opened from your wallet.");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const input = "h-9 w-full rounded-lg border border-input px-2.5 text-[13px] text-ink outline-none focus:border-violet";
  return (
    <div className="mt-4 rounded-xl bg-surface p-4">
      <div className="text-[13px] font-medium text-ink">Open the mandate from your Dynamic wallet</div>
      <p className="mt-0.5 text-[12px] text-ink-3">Your wallet signs these transactions and pays their gas; Fuku&apos;s keys are not involved.</p>
      <div className="mt-3 grid gap-2 md:grid-cols-4">
        <label className="text-[11.5px] text-ink-3">
          Daily cap (aUSDC)
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" className={input} />
        </label>
        <label className="text-[11.5px] text-ink-3">
          Per transfer
          <input value={perTx} onChange={(e) => setPerTx(e.target.value)} inputMode="decimal" className={input} />
        </label>
        <label className="text-[11.5px] text-ink-3">
          Valid (days)
          <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className={input} />
        </label>
        <label className="text-[11.5px] text-ink-3">
          Only this payee (optional)
          <input value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" className={`${input} mono`} />
        </label>
      </div>
      <button onClick={open} disabled={busy !== null} className="mt-3 h-9 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
        {busy ?? "Sign with my wallet"}
      </button>
    </div>
  );
}
