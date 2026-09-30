"use client";

import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import type { Erc8004Action, Erc8004Reason, Erc8004View } from "@/lib/services/erc8004";
import { confirmWhenMined, sendOwnerTx } from "./send-owner-tx";

const REASON_TEXT: Record<Erc8004Reason, string> = {
  "mock-chain": "The chain is mocked, so nothing can be registered on ERC-8004.",
  "unsupported-chain": "Fuku knows no canonical ERC-8004 Identity Registry on this chain (only Monad testnet).",
  "no-owner-wallet": "Bind the owner's wallet first: the agent NFT is minted to it.",
  "agent-keys-not-configured": "Registered. Binding the agent's own key needs FUKU_AGENT_KEY_SECRET on the server.",
  "owned-elsewhere": "The agent NFT is no longer held by the owner's bound wallet.",
  "agent-uri-not-public": "The agent's registration file must resolve publicly before it is registered:",
};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

/**
 * The agent on the canonical ERC-8004 Identity Registry: the NFT the owner's wallet holds, and the
 * agent's own key as its agentWallet. Fuku prepares the transactions; the owner's wallet signs them.
 */
export function Erc8004Card({ agentId }: { agentId: string }) {
  const url = `/api/agents/${encodeURIComponent(agentId)}/erc8004`;
  const { data, loading, refetch } = useJson<Erc8004View>(url);
  const [busy, setBusy] = useState<string | null>(null);

  async function send(action: Erc8004Action) {
    setBusy(action.op);
    try {
      let a = action;
      // The agent key's signature in setAgentWallet expires within minutes: take a fresh one.
      if (a.op === "erc8004SetAgentWallet") a = (await api<Erc8004View>(url)).actions.find((x) => x.op === a.op) ?? a;
      const hash = await sendOwnerTx(data?.walletVerifiedBy ?? null, a.tx);
      await confirmWhenMined(url, { op: a.op, txHash: hash });
      toast.success(a.op === "erc8004Register" ? "Registered on ERC-8004." : "The agent's own key is now its agentWallet.");
      refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function fromDemoWallet() {
    setBusy("demo");
    try {
      await api(url, { method: "POST", json: { demoWallet: true } });
      toast.success("Registered from Ava's custodial demo wallet.");
      refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const tx = (hash: string | null) =>
    hash && data ? (
      <a href={`${data.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="text-violet hover:underline">
        {short(hash)}
      </a>
    ) : null;

  return (
    <Card>
      <CardTitle action={data ? <Pill tone={data.complete ? "allow" : data.agentId ? "warn" : "neutral"}>{data.complete ? "registered" : data.agentId ? "key not bound" : "not registered"}</Pill> : null}>
        ERC-8004 identity
      </CardTitle>
      {loading || !data ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
              <Fingerprint className="size-4 text-violet" />
            </span>
            <div className="min-w-0 space-y-1 text-ink-3">
              {data.agentId && data.onChain ? (
                <>
                  <div className="text-[14px] font-medium text-ink">
                    Agent #{data.agentId}, held by <Mono>{short(data.onChain.owner)}</Mono>
                  </div>
                  <div>
                    agentWallet <Mono>{short(data.onChain.agentWallet)}</Mono>
                    {data.complete ? " (the agent's own key)" : data.agentWallet ? ` · to bind: the agent's key ${short(data.agentWallet)}` : ""}
                  </div>
                  <div>
                    register {tx(data.registerTx)}
                    {data.walletTx ? <> · setAgentWallet {tx(data.walletTx)}</> : null}
                  </div>
                </>
              ) : (
                <div>The owner&apos;s wallet mints the agent NFT, then binds the agent&apos;s own key as its agentWallet.</div>
              )}
              {data.registryId && <Mono className="block break-all text-[11px]">{data.registryId}</Mono>}
              {data.reason && (
                <div>
                  {REASON_TEXT[data.reason]}
                  {data.agentURIProblem ? ` ${data.agentURIProblem}.` : ""}
                </div>
              )}
            </div>
          </div>
          {data.actions.length > 0 && (
            <div className="divide-y divide-line rounded-xl bg-surface px-3">
              {data.actions.map((a) => (
                <div key={a.op} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0 font-medium text-ink">{a.description}</div>
                  <button
                    onClick={() => send(a)}
                    disabled={busy !== null}
                    className="h-8 shrink-0 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50"
                  >
                    {busy === a.op ? "Waiting…" : "Sign with my wallet"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {data.custodialDemo && data.actions.length > 0 && (
            <button
              onClick={fromDemoWallet}
              disabled={busy !== null}
              className="h-8 rounded-lg bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-line disabled:opacity-50"
            >
              {busy === "demo" ? "Sending…" : "Send from Ava's custodial demo wallet"}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
