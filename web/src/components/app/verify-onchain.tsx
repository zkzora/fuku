"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, ShieldQuestion, XCircle } from "lucide-react";
import { api } from "@/lib/client";
import type { ProofVerification } from "@/lib/integrations/envio";
import { cn } from "@/lib/utils";

/** Checks one ledger decision against Monad through Envio HyperRPC. */
export function VerifyOnChain({ actionId }: { actionId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProofVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<ProofVerification>("/api/onchain/verify", { method: "POST", json: { actionId } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const verified = result?.proofMatches;
  const Icon = busy ? Loader2 : !result ? ShieldQuestion : verified ? CheckCircle2 : XCircle;

  return (
    <div className="space-y-1.5">
      <button
        onClick={(e) => {
          e.stopPropagation();
          void run();
        }}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-violet ring-1 ring-line transition hover:bg-violet-soft disabled:opacity-60"
      >
        <Icon className={cn("size-3.5", busy && "animate-spin")} />
        {busy ? "Checking Monad…" : result ? "Check again" : "Verify on-chain"}
      </button>
      {result && (
        <p className={cn("text-[12px] leading-snug", verified ? "text-allow" : "text-ink-3")}>
          {result.message}
          {result.onChain ? ` Rule ${result.onChain.ruleId}, ${result.onChain.allowed ? "allowed" : "blocked"} on-chain.` : ""}
          <span className="block text-[11px] text-ink-3">via Envio HyperRPC</span>
        </p>
      )}
      {error && <p className="text-[12px] text-block">{error}</p>}
    </div>
  );
}
