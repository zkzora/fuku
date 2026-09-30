"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import type { OwnerAction, OwnerActionsView } from "@/lib/services/owner-actions";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
const DYNAMIC_ENABLED = Boolean(process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID);

/**
 * Who controls this identity on-chain, and the registry writes the owner's wallet still has to send.
 * Fuku prepares each transaction; the owner's wallet signs and pays for it; Fuku then confirms it by
 * reading the receipt and the decoded event.
 */
export function OwnerActionsCard({ walletVerifiedBy, isDemo }: { walletVerifiedBy: string | null; isDemo: boolean }) {
  const { data, loading, refetch } = useJson<OwnerActionsView>("/api/chain/owner-actions");
  const [busy, setBusy] = useState<string | null>(null);

  async function send(action: OwnerAction) {
    const id = `${action.op}:${action.agentId ?? ""}`;
    setBusy(id);
    try {
      let hash: string;
      if (walletVerifiedBy === "dynamic" && DYNAMIC_ENABLED) {
        const { sendViaDynamic } = await import("@/components/dynamic/dynamic-send");
        hash = await sendViaDynamic(action.tx.from, action.tx);
      } else {
        const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
        if (!eth) throw new Error("No browser wallet found. Use the wallet bound to this identity.");
        const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        if (account.toLowerCase() !== action.tx.from.toLowerCase()) throw new Error(`Switch the wallet to ${action.tx.from}.`);
        hash = (await eth.request({ method: "eth_sendTransaction", params: [{ from: account, to: action.tx.to, data: action.tx.data, value: "0x0" }] })) as string;
      }
      // The server confirms from the chain; retry while the transaction is being mined.
      for (let i = 0; i < 45; i++) {
        try {
          await api("/api/chain/owner-actions", { method: "POST", json: { op: action.op, txHash: hash, agentId: action.agentId } });
          toast.success(`${action.description}: confirmed on-chain.`);
          refetch({ silent: true });
          return;
        } catch (err) {
          if (i === 44 || !/not found|could not be found|receipt/i.test((err as Error).message)) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardTitle>On-chain control</CardTitle>
      {loading || !data ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
              <KeyRound className="size-4 text-violet" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium text-ink">{data.custody === "owner" ? "Your wallet controls this identity" : "Fuku's relayer controls this identity"}</span>
                <Pill tone={data.custody === "owner" ? "allow" : "warn"} className="normal-case tracking-normal">
                  {data.custody === "owner" ? "owner-controlled" : isDemo ? "custodial demo" : "custodial"}
                </Pill>
              </div>
              <div className="text-ink-3">
                {data.reason === "mock-chain"
                  ? "The chain is mocked, so nothing is registered on-chain."
                  : data.controller
                    ? (
                      <>
                        Registry controller <Mono className="break-all">{data.controller}</Mono>
                      </>
                    )
                    : "Not registered on-chain yet."}
              </div>
              {data.custody === "relayer" && (
                <div className="mt-1 text-[12px] text-ink-3">
                  {isDemo
                    ? "The seeded demo identity stays custodial by design."
                    : "Bind a wallet before your first agent to control your identity on-chain yourself; an identity the relayer already registered stays custodial (the registry has no controller transfer)."}
                </div>
              )}
            </div>
          </div>
          {data.actions.length > 0 && (
            <div className="divide-y divide-line rounded-xl bg-surface px-3">
              {data.actions.map((a) => {
                const id = `${a.op}:${a.agentId ?? ""}`;
                return (
                  <div key={id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{a.description}</div>
                      <Mono className="text-[11px]">
                        {a.op} → {a.tx.to.slice(0, 10)}…
                      </Mono>
                    </div>
                    <button
                      onClick={() => send(a)}
                      disabled={busy !== null}
                      className="h-8 shrink-0 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50"
                    >
                      {busy === id ? "Waiting…" : "Sign with my wallet"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {data.custody === "owner" && data.actions.length === 0 && data.reason === null && (
            <p className="text-ink-3">Everything is anchored by your wallet. Revoking or pausing an agent on-chain will ask for your signature here.</p>
          )}
        </div>
      )}
    </Card>
  );
}
