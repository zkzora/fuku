"use client";

import { useState } from "react";
import { stringToHex } from "viem";
import { toast } from "sonner";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { api } from "@/lib/client";
import type { VerificationStatus } from "@/lib/services/identity";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/**
 * What Fuku can and cannot vouch for about this owner, each with its evidence: the passkey
 * ceremony, control of the owner wallet, unique personhood (never claimed) and Cleanverse
 * eligibility. The wallet can be bound here by signing a one-time message with a browser wallet.
 */
export function VerificationCard({ verification, onChanged }: { verification: VerificationStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function bindWallet() {
    const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!eth) {
      toast.error("No browser wallet found. Link a wallet with Dynamic, or bind one through the API (POST then PUT /api/identity/wallet).");
      return;
    }
    setBusy(true);
    try {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const ch = await api<{ challengeId: string; message: string }>("/api/identity/wallet", { method: "POST", json: { wallet: account } });
      const signature = (await eth.request({ method: "personal_sign", params: [stringToHex(ch.message), account] })) as string;
      await api("/api/identity/wallet", { method: "PUT", json: { challengeId: ch.challengeId, signature } });
      toast.success("Wallet bound: control proven with a signature.");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const v = verification;
  const rows: { label: string; status: string; tone: "allow" | "warn" | "block" | "neutral"; evidence: React.ReactNode }[] = [
    {
      label: "Passkey",
      status: v.passkey.status === "verified" ? "verified" : "none",
      tone: v.passkey.status === "verified" ? "allow" : "warn",
      evidence: v.passkey.evidence,
    },
    {
      label: "Owner wallet",
      status: v.wallet.status,
      tone: v.wallet.status === "verified" ? "allow" : v.wallet.status === "declared" ? "warn" : "neutral",
      evidence: v.wallet.address ? (
        <>
          <Mono className="break-all">{v.wallet.address}</Mono>
          {v.wallet.status === "verified"
            ? ` · ${v.wallet.method === "dynamic" ? "Dynamic-verified credential" : "signed binding"}`
            : " · declared only, not proven"}
        </>
      ) : (
        "No wallet on record"
      ),
    },
    {
      label: "Unique human",
      status: "not established",
      tone: "neutral",
      evidence: v.uniqueHuman.evidence,
    },
    {
      label: "Cleanverse A-Pass",
      status: v.cleanverse.status,
      tone: v.cleanverse.status === "eligible" ? "allow" : v.cleanverse.status === "off" || v.cleanverse.status === "unchecked" ? "neutral" : "warn",
      evidence:
        v.cleanverse.status === "unbound"
          ? "Needs a verified owner wallet first."
          : `${v.cleanverse.source === "simulated" ? "Cleanverse simulator" : "Cleanverse"}${v.cleanverse.checkedAt ? ` · read ${new Date(v.cleanverse.checkedAt).toLocaleString()}` : ""}`,
    },
  ];

  return (
    <Card>
      <CardTitle>What Fuku can vouch for</CardTitle>
      <div className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">{r.label}</div>
              <div className="text-[12.5px] text-ink-3">{r.evidence}</div>
            </div>
            <Pill tone={r.tone} className="normal-case tracking-normal">
              {r.status}
            </Pill>
          </div>
        ))}
      </div>
      {v.wallet.status !== "verified" && (
        <button
          onClick={bindWallet}
          disabled={busy}
          className="mt-4 inline-flex h-10 items-center rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50"
        >
          {busy ? "Waiting for the wallet…" : "Prove wallet control with a signature"}
        </button>
      )}
    </Card>
  );
}
