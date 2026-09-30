"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardTitle, Pill } from "@/components/bits";
import { api } from "@/lib/client";
import type { ScoreVerification } from "@/lib/services/verify-score";

const show = (v: number | boolean | null) => (v === null ? "not on-chain" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

/**
 * "Recompute from chain": the score recomputed from on-chain evidence, next to the score Fuku anchored
 * and its ledger's, with every input the chain cannot show named as such.
 */
export function ScoreVerifyCard({ agentId }: { agentId: string }) {
  const [result, setResult] = useState<ScoreVerification | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      setResult(await api<ScoreVerification>(`/api/agents/${encodeURIComponent(agentId)}/verify-score`));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle
        action={
          <button onClick={run} disabled={busy} className="h-8 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
            {busy ? "Reading the chain…" : "Recompute from chain"}
          </button>
        }
      >
        Verify the score
      </CardTitle>
      {!result ? (
        <p className="text-[13px] text-ink-3">
          Recompute this agent&apos;s score from the registries and the guard, and see which inputs only Fuku&apos;s ledger holds.
        </p>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex flex-wrap gap-2">
            <Pill tone="violet" className="normal-case tracking-normal">
              From chain {result.chainScore}
            </Pill>
            <Pill tone={result.matches.anchored ? "allow" : "warn"} className="normal-case tracking-normal">
              Anchored {result.anchored ? result.anchored.score : "none"}
            </Pill>
            <Pill tone={result.matches.ledger ? "allow" : "warn"} className="normal-case tracking-normal">
              Ledger {result.ledgerScore}
            </Pill>
            <Pill tone="neutral" className="normal-case tracking-normal">
              Chain alone {result.chainOnlyScore}
            </Pill>
          </div>
          <div className="divide-y divide-line rounded-xl bg-surface px-3">
            {result.inputs.map((i) => (
              <div key={i.key} className="flex items-center justify-between gap-3 py-2">
                <span className="text-ink">{i.label}</span>
                <span className="text-ink-3">
                  chain {show(i.chain)} · ledger {show(i.ledger)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-ink-3">
            {result.events.decisions} decisions and {result.events.executions} transfers read via {result.events.source === "rpc" ? "RPC" : "Envio HyperSync"}, blocks{" "}
            {result.events.fromBlock}–{result.events.toBlock}. {result.scoringVersion}.
          </p>
          {result.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-3">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
