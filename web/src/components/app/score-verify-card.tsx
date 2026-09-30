"use client";

import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Pill } from "@/components/bits";
import { api } from "@/lib/client";
import type { ScoreVerification } from "@/lib/services/verify-score";

const show = (v: number | boolean | null) => (v === null ? "not on-chain" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

/**
 * "Recompute from chain" (commit-reveal): the decision records Fuku reveals are checked against the
 * proofs anchored on-chain, the score is recomputed from checked records and on-chain state, and the
 * inputs the chain does not commit to are listed.
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

  const r = result?.records;
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
      {!result || !r ? (
        <p className="text-[13px] text-ink-3">
          Check every decision record Fuku keeps for this agent against the proof anchored on-chain, and recompute the score from what checks out.
        </p>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-center gap-2">
            {result.verified ? <CheckCircle2 className="size-5 text-allow" /> : <XCircle className="size-5 text-block" />}
            <span className="text-[14px] font-medium text-ink">
              {result.verified ? `Verified: the chain supports ${result.chainScore}` : `Not verified: the chain supports ${result.chainScore}`}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill tone="violet" className="normal-case tracking-normal">
              From chain {result.chainScore}
            </Pill>
            <Pill tone={result.anchored?.score === result.chainScore ? "allow" : "warn"} className="normal-case tracking-normal">
              Anchored {result.anchored ? result.anchored.score : "none"}
            </Pill>
            <Pill tone={result.ledgerScore === result.chainScore ? "allow" : "warn"} className="normal-case tracking-normal">
              Ledger {result.ledgerScore}
            </Pill>
          </div>
          <p className="text-ink-3">
            {r.verified} of {r.revealed} revealed records match their on-chain proofs
            {r.mismatched.length ? `, ${r.mismatched.length} do not` : ""}
            {r.unanchored.length ? `, ${r.unanchored.length} are not anchored` : ""}; {r.unrevealed.length} on-chain decisions have no record.
          </p>
          <div className="divide-y divide-line rounded-xl bg-surface px-3">
            {result.inputs.map((i) => (
              <div key={i.key} className="flex items-center justify-between gap-3 py-2">
                <span className="text-ink">
                  {i.label}
                  {!i.committed && <span className="text-ink-3"> · not committed</span>}
                </span>
                <span className="text-ink-3">
                  chain {show(i.chain)} · ledger {show(i.ledger)}
                </span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">Not committed on-chain</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[12.5px] text-ink-3">
              {result.notCommitted.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
          {result.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-3">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-ink-3">
            {result.events.decisions} decisions and {result.events.executions} transfers via {result.events.source === "rpc" ? "RPC" : "Envio HyperSync"}, blocks{" "}
            {result.events.fromBlock}–{result.events.toBlock}. {result.scoringVersion}.
          </p>
        </div>
      )}
    </Card>
  );
}
